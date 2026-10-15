import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { AbsClient } from '../books/absClient';
import { boundedQuery } from '../books/limits';
import { BooksConfig } from '../books/types';

const libraryId = '163ac435-50a9-4f56-96d0-276edf9303c1';
const signal = () => new AbortController().signal;
const generated = (count = 121) => Array.from({ length: count }, (_, index) =>
  ['ebook', 'single', 'mixed'].map(kind => ({
    id: `${kind}-${index}`, libraryId, mediaType: 'book',
    ino: `generated-${kind}-${index}`, folderId: 'generated-folder',
    path: `/owned-fixtures/${kind}/${index}`, relPath: `${kind}/${index}`,
    addedAt: 1700000000000, updatedAt: 1700000000000, size: 10000,
    isMissing: index === 119, isInvalid: false,
    media: {
      metadata: {
        title: `Title ${String(index).padStart(4, '0')} ${kind}`,
        subtitle: `Generated subtitle fixture-${index}`,
        authorName: index === 120 ? 'Needle Author' : `Author ${String(120 - index).padStart(3, '0')}`,
        description: 'Generated library metadata with a representative description. '.repeat(8),
        authors: undefined,
        genres: ['Generated Fiction'], narrators: ['Generated Narrator'], language: 'en',
        publishedYear: '2026', publisher: 'Generated Publisher', asin: `ASIN-${index}`, isbn: `ISBN-${index}`,
      },
      ebookFormat: kind === 'single' ? null : index === 120 ? 'azw3' : index % 2 ? 'epub' : 'cbz',
      numAudioFiles: kind === 'ebook' ? 0 : kind === 'single' ? 1 : 2,
      numTracks: index === 118 || index === 119 ? 0 : kind === 'ebook' ? 0 : kind === 'single' ? 1 : 2,
    },
  }))).flat();

async function provider(count = 121) {
  let items = generated(count);
  let mode: 'normal' | 'denied' | 'duplicate' | 'changed' | 'wrong-library' | 'oversized' | 'too-many' |
    'full-search' | 'aggregate' | 'delayed' | 'malformed-search' | 'duplicate-search' = 'normal';
  const requests: URL[] = [];
  let bytes = 0;
  let maximumResponseBytes = 0;
  let requested!: () => void;
  const received = new Promise<void>(resolve => { requested = resolve; });
  // ABS 2.30 LibraryController.getLibraryItems + getMediaGroupQuery:
  // one native filter precedes count/offset; tracks has none/multi/otherwise-single.
  // Its search endpoint accepts q+limit only, never category/page.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    requests.push(url);
    requested();
    if (mode === 'denied') { res.writeHead(403).end(); return; }
    if (mode === 'delayed') return;
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'oversized') { res.end('x'.repeat(8 * 1024 * 1024 + 1)); return; }
    const json = (value: unknown) => {
      const body = JSON.stringify(value);
      bytes += Buffer.byteLength(body);
      maximumResponseBytes = Math.max(maximumResponseBytes, Buffer.byteLength(body));
      res.end(body);
    };
    if (url.pathname === `/api/libraries/${libraryId}/search`) {
      if (mode === 'malformed-search') { json({ authors: [] }); return; }
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const limit = Number(url.searchParams.get('limit') ?? 12);
      const matches = items.filter(item => {
        const meta = item.media.metadata;
        return [meta.title, meta.subtitle, meta.asin, meta.isbn].some(value => value.toLowerCase().includes(q));
      });
      if (mode === 'full-search') {
        json({ book: Array.from({ length: limit }, (_, index) => ({ libraryItem: {
          id: `full-${index}`, libraryId, mediaType: 'book', media: { metadata: {}, ebookFormat: 'epub', numAudioFiles: 0 },
        } })) });
        return;
      }
      const selected = mode === 'duplicate-search' ? [matches[0], matches[0]] : matches.slice(0, limit);
      json({
        book: selected.map(item => ({ libraryItem: {
          ...item,
          media: {
            ...item.media,
            ebookFile: item.media.ebookFormat ? { ebookFormat: item.media.ebookFormat, ino: `${item.id}-ebook` } : null,
            audioFiles: Array.from({ length: item.media.numAudioFiles }, (_, index) => ({ ino: `${item.id}-${index}`, duration: 10 })),
            tracks: [], chapters: [],
          },
          libraryFiles: [{ ino: `${item.id}-original`, fileType: 'ebook', metadata: {
            filename: `${item.media.metadata.title}.epub`, size: 10000, mtimeMs: 1700000000000,
            path: `${item.path}/original.epub`, relPath: 'original.epub', ext: '.epub',
          } }],
        } })),
        authors: [], narrators: [], tags: [], series: [],
      });
      return;
    }
    if (url.pathname !== `/api/libraries/${libraryId}/items`) { res.writeHead(404).end(); return; }
    const filter = url.searchParams.get('filter');
    const [group, encoded] = (filter ?? '').split('.');
    const value = Buffer.from(encoded ?? '', 'base64').toString();
    const selected = items.filter(item => group === 'ebooks'
      ? value === 'ebook' ? item.media.ebookFormat !== null : item.media.ebookFormat === null
      : group === 'tracks'
        ? value === 'none' ? item.media.numAudioFiles === 0 : value === 'multi'
          ? item.media.numAudioFiles > 1 : item.media.numAudioFiles === 1
        : true);
    selected.sort((a, b) => {
      const author = url.searchParams.get('sort') === 'media.metadata.authorName';
      const order = (author ? a.media.metadata.authorName.localeCompare(b.media.metadata.authorName, 'en') : 0) ||
        a.media.metadata.title.localeCompare(b.media.metadata.title, 'en');
      return url.searchParams.get('desc') === '1' ? -order : order;
    });
    const page = Number(url.searchParams.get('page') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    let results = selected.slice(page * limit, (page + 1) * limit);
    if (mode === 'duplicate' && page > 0) results = selected.slice(0, results.length);
    if (mode === 'wrong-library') results = results.map(item => ({ ...item, libraryId: 'unselected' }));
    json({
      results: mode === 'aggregate' ? results.map(item => ({ ...item, extra: 'x'.repeat(60000) })) : results,
      total: mode === 'too-many' ? 10001 : selected.length + (mode === 'changed' && page > 0 ? 1 : 0),
      page, limit,
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config: BooksConfig = {
    enabled: true, providerInstanceId: 'generated-provider', configGeneration: 1,
    origin: `http://127.0.0.1:${address.port}`, libraryId, serverBindingProofId: 'generated-binding',
  };
  const client = new AbsClient(config, 'owned-fixture-only', { fileId: () => 'unused-file' });
  return {
    client, requests, received, get bytes() { return bytes; }, get maximumResponseBytes() { return maximumResponseBytes; },
    setMode(value: typeof mode) { mode = value; },
    remove(id: string) { items = items.filter(item => item.id !== id); },
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

test('category_membership_precedes_count_and_every_page_including_mixed_missing_and_unsupported', async () => {
  const f = await provider();
  try {
    for (const category of ['books', 'ebooks']) {
      const first = await f.client.list(boundedQuery({ category, limit: '50' }), signal());
      assert.equal(first.total, 242);
      assert.equal(first.items.length, 50);
      assert.deepEqual(first.items.slice(0, 4).map(item => item.itemId),
        category === 'books' ? ['mixed-0', 'single-0', 'mixed-1', 'single-1'] : ['ebook-0', 'mixed-0', 'ebook-1', 'mixed-1']);
      const last = await f.client.list(boundedQuery({ category, page: '4', limit: '50' }), signal());
      assert.equal(last.total, 242);
      assert.equal(last.items.length, 42);
      assert.ok(last.items.some(item => item.itemId === 'mixed-119' && item.missing));
      assert.ok(last.items.some(item => item.itemId === 'mixed-118' && item.audioTrackCount === 2 && !item.listen.available));
      assert.ok(last.items.some(item => item.itemId === 'mixed-120' && item.hasEbook));
      assert.equal(last.items.some(item => item.itemId === 'ebook-120'), category === 'ebooks');
      assert.ok([...first.items, ...last.items].every(item => category === 'books' ? item.audioTrackCount > 0 : item.hasEbook));
    }
    assert.ok(f.requests.every(url => Number(url.searchParams.get('limit')) <= 100));
    assert.ok(f.requests.every(url => ['ebooks.ZWJvb2s=', 'tracks.c2luZ2xl', 'tracks.bXVsdGk='].includes(url.searchParams.get('filter')!)));
  } finally { await f.close(); }
});

test('category_search_preserves_native_matching_beyond_first_batch_with_sort_and_pagination', async () => {
  const f = await provider();
  try {
    const result = await f.client.list(boundedQuery({ category: 'books', q: 'fixture-120' }), signal());
    assert.equal(result.total, 2);
    assert.deepEqual(result.items.map(item => item.itemId), ['mixed-120', 'single-120']);
    const paged = await f.client.list(boundedQuery({ category: 'ebooks', q: 'Title', page: '2', limit: '50', desc: 'true' }), signal());
    assert.equal(paged.total, 242);
    assert.equal(paged.items.length, 50);
    assert.deepEqual(paged.items.slice(0, 4).map(item => item.itemId), ['mixed-70', 'ebook-70', 'mixed-69', 'ebook-69']);
    const author = await f.client.list(boundedQuery({ category: 'books', sort: 'author', limit: '2' }), signal());
    assert.deepEqual(author.items.map(item => item.itemId), ['mixed-119', 'single-119']);
    const none = await f.client.list(boundedQuery({ category: 'ebooks', q: 'unmatched phrase' }), signal());
    assert.deepEqual(none.items, []);
    assert.equal(none.total, 0);
    assert.equal((await f.client.list(boundedQuery({ category: 'books', q: 'Needle Author' }), signal())).total, 0,
      'Do not silently replace native book matching with author matching');
    assert.ok(f.requests.filter(url => url.pathname.endsWith('/search')).every(url => url.searchParams.get('limit') === '10000'));
  } finally { await f.close(); }
});

test('category_audio_inventory_filters_keep_single_and_multi_distinct', async () => {
  const f = await provider();
  try {
    for (const filter of ['single', 'multi']) {
      const result = await f.client.list(boundedQuery({ category: 'books', filter, q: 'Title', page: '2' }), signal());
      assert.equal(result.total, 121);
      assert.equal(result.items.length, 21);
      assert.ok(result.items.every(item => filter === 'single' ? item.audioTrackCount === 1 : item.audioTrackCount > 1));
    }
  } finally { await f.close(); }
});

test('category_refresh_observes_inventory_and_provider_permission_changes_without_cache_authority', async () => {
  const f = await provider();
  try {
    const query = boundedQuery({ category: 'ebooks', q: 'fixture-120' });
    assert.equal((await f.client.list(query, signal())).total, 2);
    f.remove('ebook-120');
    assert.deepEqual((await f.client.list(query, signal())).items.map(item => item.itemId), ['mixed-120']);
    f.setMode('denied');
    await assert.rejects(f.client.list(query, signal()), { code: 'ABS_CONNECTION_DENIED' });
  } finally { await f.close(); }
});

test('category_query_validation_rejects_unsupported_combinations_and_preserves_legacy_contract', () => {
  assert.equal(boundedQuery({}).filter, 'all');
  assert.equal(boundedQuery({ limit: '1000' }).limit, 100);
  for (const query of [
    { category: 'audio' }, { category: ['books'] }, { category: 'books', filter: 'ebook' },
    { category: 'ebooks', filter: 'multi' }, { category: 'books', q: ['title'] },
    { category: 'books', q: 'x'.repeat(201) }, { q: 'without category' }, { category: 'books', offset: '50' },
  ]) assert.throws(() => boundedQuery(query), { status: 400 });
});

for (const [mode, code] of [
  ['duplicate', 'ABS_CATALOG_CHANGED'], ['changed', 'ABS_CATALOG_CHANGED'],
  ['wrong-library', 'BOOK_NOT_FOUND'], ['oversized', 'ABS_RESPONSE_TOO_LARGE'],
  ['too-many', 'BOOKS_CATEGORY_CAPACITY'],
] as const) {
  test(`category_${mode}_fails_explicitly_without_partial_success`, async () => {
    const f = await provider();
    try {
      f.setMode(mode);
      await assert.rejects(f.client.list(boundedQuery({ category: 'books' }), signal()), { code });
      assert.ok(f.requests.length <= 3);
    } finally { await f.close(); }
  });
}

test('category_search_full_provider_batch_is_rejected_not_presented_as_complete', async () => {
  const f = await provider();
  try {
    f.setMode('full-search');
    await assert.rejects(f.client.list(boundedQuery({ category: 'ebooks', q: 'Title' }), signal()),
      { code: 'BOOKS_CATEGORY_CAPACITY' });
  } finally { await f.close(); }
});

test('current_scale_4965_interleaved_items_have_complete_search_and_bounded_browse', async t => {
  const f = await provider(1655);
  const started = performance.now();
  try {
    const ebook = await f.client.list(boundedQuery({ category: 'ebooks', page: '66' }), signal());
    assert.equal(ebook.total, 3310);
    assert.equal(ebook.items.length, 10);
    assert.deepEqual(ebook.items.slice(-4).map(item => item.itemId), ['ebook-1653', 'mixed-1653', 'ebook-1654', 'mixed-1654']);
    assert.equal(f.requests.length, 1, 'Ordinary ebook browsing must remain native paginated');
    const audio = await f.client.list(boundedQuery({ category: 'books', page: '66' }), signal());
    assert.equal(audio.total, 3310);
    assert.equal(audio.items.length, 10);
    assert.deepEqual(audio.items.slice(-4).map(item => item.itemId), ['mixed-1653', 'single-1653', 'mixed-1654', 'single-1654']);
    assert.ok(f.requests.length <= 35, 'Audio union uses bounded sequential native partitions');
    const matches = await f.client.list(boundedQuery({ category: 'ebooks', q: 'Title', page: '66' }), signal());
    assert.equal(matches.total, 3310);
    assert.deepEqual(matches.items.map(item => item.itemId), ebook.items.map(item => item.itemId));
    t.diagnostic(JSON.stringify({
      fixtureItems: 4965, categoryItems: 3310, responseBytes: f.bytes, maximumResponseBytes: f.maximumResponseBytes,
      requests: f.requests.length, milliseconds: performance.now() - started,
    }));
  } finally { await f.close(); }
});

test('category_aggregate_budget_stops_sequential_work_without_relaxing_per_response_limit', async () => {
  const f = await provider(700);
  try {
    f.setMode('aggregate');
    await assert.rejects(f.client.list(boundedQuery({ category: 'books' }), signal()), { code: 'BOOKS_CATEGORY_CAPACITY' });
    assert.equal(f.requests.length, 6);
    assert.ok(f.maximumResponseBytes < 8 * 1024 * 1024);
  } finally { await f.close(); }
});

test('category_request_cancellation_aborts_provider_and_stops_the_scan', async () => {
  const f = await provider();
  try {
    f.setMode('delayed');
    const controller = new AbortController();
    const result = f.client.list(boundedQuery({ category: 'books' }), controller.signal);
    await f.received;
    controller.abort();
    await assert.rejects(result, { code: 'ABS_UNAVAILABLE' });
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

for (const [mode, code] of [['malformed-search', 'ABS_INVALID_RESPONSE'], ['duplicate-search', 'ABS_CATALOG_CHANGED']] as const) {
  test(`category_${mode}_cannot_be_reported_as_empty_or_complete`, async () => {
    const f = await provider();
    try {
      f.setMode(mode);
      await assert.rejects(f.client.list(boundedQuery({ category: 'ebooks', q: 'Title' }), signal()), { code });
    } finally { await f.close(); }
  });
}
