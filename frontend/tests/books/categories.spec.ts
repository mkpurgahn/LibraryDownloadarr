import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test, expect, signIn, capture, originalDownload } from './harness';
import { parseBookItem, BookTarget } from '../../src/books/types';

test('confirmed_categories_separate_reading_and_audio_inventory_and_badges', async ({ page, app }, info) => {
  await signIn(page, app);
  await expect(page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Download-only Archive', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open One Hundred and One Tracks', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Available sources' })).toHaveCount(0);
  await expect(page.locator('main').getByText(/audio tracks|All audio/)).toHaveCount(0);
  await expect(page.getByText('2 books - Page 1', { exact: true })).toBeVisible();
  await capture(page, 'books-reading-only', info);
  await page.goto(`${app.origin}/audiobooks`);
  await expect(page.getByRole('heading', { name: 'Audiobooks', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open One Hundred and One Tracks', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Download-only Archive', exact: true })).toHaveCount(0);
  await expect(page.locator('main').getByText('Ebook', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Available sources' }).locator('option'))
    .toHaveText(['All audio', 'Single-track audio', 'Multi-track audio']);
  await expect(page.getByText('2 audiobooks - Page 1', { exact: true })).toBeVisible();
  await capture(page, 'audiobooks-audio-only', info);
});

test('category_detail_and_bulk_downloads_only_request_the_sections_original_roles', async ({ page, app }, info) => {
  await signIn(page, app);
  await page.goto(`${app.origin}/books/items/dual`);
  await expect(page.getByRole('heading', { name: 'A Tale in Two Formats', exact: true })).toBeVisible();
  const response = await page.request.get(`${app.origin}/api/books/items/dual`);
  expect(response.status()).toBe(200);
  const item = parseBookItem(await response.json());
  const batches: BookTarget[][] = [];
  const downloadedOriginals: Array<{ section: string; fileId: string; sha256: string }> = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/books/download-tickets') batches.push(request.postDataJSON().targets);
  });
  for (const section of ['books', 'audiobooks'] as const) {
    const reading = section === 'books';
    const files = item.files.filter(file => file.role === (reading ? 'ebook' : 'audio'));
    expect(files).toHaveLength(2);
    await page.goto(`${app.origin}/${section}/items/dual`);
    await expect(page.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: `Back to ${reading ? 'Books' : 'Audiobooks'}`, exact: true }))
      .toHaveAttribute('href', `/${section}`);
    await expect(page.getByRole('combobox', { name: 'Ebook original', exact: true })).toHaveCount(reading ? 1 : 0);
    await expect(page.getByRole('link', { name: 'Read', exact: true })).toHaveCount(reading ? 1 : 0);
    await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Listen', exact: true })).toHaveCount(reading ? 0 : 1);
    const originals = page.getByRole('region', { name: 'Original files', exact: true });
    await expect(originals.getByRole('listitem')).toHaveCount(2);
    for (const file of files) await expect(originals.getByRole('button', { name: `Download original ${file.basename}`, exact: true })).toBeVisible();
    for (const file of item.files.filter(file => !files.includes(file))) await expect(originals.getByText(file.basename, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show more originals', exact: true })).toHaveCount(0);
    await capture(page, `${section}-mixed-scoped-detail`, info);
    const previous = batches.length;
    const downloaded = await originalDownload(page, () => page.getByRole('button', { name: 'Prepare all downloads', exact: true }).click(), info);
    await downloaded.saveAs(info.outputPath(`${section}-first-original.bin`));
    expect(await downloaded.failure()).toBeNull();
    await expect.poll(() => batches.length).toBe(previous + 1);
    expect(batches.at(-1)).toEqual(files.map(file => ({ itemId: 'dual', fileId: file.fileId, contentVersion: file.contentVersion })));
    const first = await fs.readFile(info.outputPath(`${section}-first-original.bin`));
    expect(first.length).toBe(files[0].size);
    expect(downloaded.suggestedFilename().replaceAll('_', ' ')).toBe(files[0].basename);
    if (reading) expect(first.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    else expect(first).toEqual(Buffer.from('Generated authorized original dual 2\n'.repeat(32)));
    downloadedOriginals.push({ section, fileId: files[0].fileId, sha256: createHash('sha256').update(first).digest('hex') });
  }
  await page.goto(`${app.origin}/books/items/unsupported`);
  await expect(page.getByRole('button', { name: 'Read', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Listen', exact: true })).toHaveCount(0);
  const download = await originalDownload(page, () => page.getByRole('button', { name: /Download original/ }).click(), info);
  await download.saveAs(info.outputPath('unsupported-original.bin'));
  const bytes = await fs.readFile(info.outputPath('unsupported-original.bin'));
  expect(bytes).toEqual(Buffer.from('Generated authorized original unsupported 0\n'.repeat(32)));
  await fs.writeFile(info.outputPath('separated-originals.json'), JSON.stringify({
    batches, downloadedOriginals, unsupportedSha256: createHash('sha256').update(bytes).digest('hex'),
    readingAndAudioFilesUnchanged: true, roleScopedBulkTargets: true,
  }, null, 2));
});

test('canonical_and_legacy_links_preserve_reading_and_audio_resume_without_mixed_controls', async ({ page, app }, info) => {
  test.skip(process.platform === 'win32' && info.project.name.startsWith('webkit-'),
    'Positive native audio decoding requires Linux WebKit; Windows codec limitation is unchanged.');
  await app.setAudio('normal');
  await signIn(page, app);
  await page.goto(`${app.origin}/books/items/dual`);
  const read = page.getByRole('link', { name: 'Read', exact: true });
  const readerPath = await read.getAttribute('href');
  expect(readerPath).toMatch(/^\/books\/items\/dual\/read\//);
  await read.click();
  const reader = page.frameLocator('iframe[title="EPUB reader"]');
  await expect(reader.getByRole('heading', { name: 'First section', exact: true })).toBeVisible();
  await reader.getByRole('button', { name: 'Next section', exact: true }).click();
  await expect(reader.getByRole('heading', { name: 'Second section', exact: true })).toBeVisible();
  await expect(page.getByText('Position saved', { exact: true })).toBeVisible();
  await capture(page, 'books-rendered-saved-original', info);
  await page.getByRole('link', { name: 'Back to book', exact: true }).click();
  await page.goto(`${app.origin}${readerPath!.replace('/books/', '/ebooks/')}`);
  await expect(page).toHaveURL(`${app.origin}${readerPath}`);
  await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
  await expect(reader.getByRole('heading', { name: 'Second section', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to book', exact: true })).toHaveAttribute('href', '/books/items/dual');
  await page.goto(`${app.origin}/ebooks/items/dual`);
  await expect(page).toHaveURL(`${app.origin}/audiobooks/items/dual`);
  await expect(page.getByRole('link', { name: 'Read', exact: true })).toHaveCount(0);
  await page.getByTestId('books-audio').evaluate(element => {
    if (element instanceof HTMLAudioElement) element.volume = 0;
  });
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Audiobook player' }).getByRole('link')).toHaveAttribute('href', '/audiobooks/items/dual');
  await expect(async () => {
    const resume = page.getByRole('button', { name: 'Tap to resume', exact: true });
    if (await resume.isVisible()) await resume.click();
    const audio = await page.getByTestId('books-audio').evaluate(element => {
      if (!(element instanceof HTMLAudioElement)) throw new Error('Native audio element missing');
      return { time: element.currentTime, ready: element.readyState, paused: element.paused, error: element.error?.code };
    });
    expect(audio.error).toBeUndefined(); expect(audio.paused).toBe(false);
    expect(audio.ready).toBeGreaterThanOrEqual(2); expect(audio.time).toBeGreaterThan(0.3);
  }).toPass({ timeout: 10000 });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const saved = page.waitForResponse(response => response.request().method() === 'PUT' &&
    response.url().endsWith('/progress/audio') && response.status() === 200 && response.request().postDataJSON().op === 'save');
  await page.getByRole('button', { name: 'Close audiobook', exact: true }).click();
  const seconds = (await (await saved).json()).progress.locator.globalSeconds;
  expect(seconds).toBeGreaterThan(0.2);
  await expect(page.getByRole('region', { name: 'Audiobook player' })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
  await expect.poll(() => page.getByTestId('books-audio').evaluate(element =>
    element instanceof HTMLAudioElement ? element.currentTime : -1)).toBeGreaterThanOrEqual(seconds);
  await capture(page, 'audiobooks-resumed-original', info);
  await page.getByRole('button', { name: 'Close audiobook', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Audiobook player' })).toHaveCount(0);
  await page.goto(`${app.origin}/books/items/collection`);
  await expect(page).toHaveURL(`${app.origin}/audiobooks/items/collection`);
  await expect(page.getByRole('region', { name: 'Original files' }).getByRole('listitem')).toHaveCount(50);
  await page.getByRole('button', { name: 'Show more originals', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Original files' }).getByRole('listitem')).toHaveCount(100);
  await page.getByRole('button', { name: 'Show more originals', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Original files' }).getByRole('listitem')).toHaveCount(101);
  await expect(page.getByRole('button', { name: 'Show more originals', exact: true })).toHaveCount(0);
  for (const prefix of ['ebooks', 'audiobooks']) {
    await page.goto(`${app.origin}/${prefix}/items/unsupported`);
    await expect(page).toHaveURL(`${app.origin}/books/items/unsupported`);
    await expect(page.getByRole('button', { name: 'Listen', exact: true })).toHaveCount(0);
  }
  await page.goto(`${app.origin}/ebooks`);
  await expect(page).toHaveURL(`${app.origin}/audiobooks`);
});

test('audio_category_search_keeps_filters_counts_and_truthful_retry', async ({ page, app }, info) => {
  await signIn(page, app);
  await page.goto(`${app.origin}/audiobooks`);
  await page.getByRole('combobox', { name: 'Available sources' }).selectOption('single');
  await page.getByRole('textbox', { name: 'Search audiobooks', exact: true }).fill('Two Formats');
  await page.getByRole('textbox', { name: 'Search audiobooks', exact: true }).press('Enter');
  await expect(page.getByText('No audiobooks found', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Available sources' }).selectOption('multi');
  await expect(page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true })).toBeVisible();
  await expect(page.getByText('1 audiobooks - Page 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  await capture(page, 'audiobooks-filtered-search', info);
  app.setUnavailable(true);
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('No audiobooks found', { exact: true })).toHaveCount(0);
  app.setUnavailable(false);
  await page.getByRole('button', { name: 'Retry Audiobooks', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true })).toBeVisible();
});

test('category_switch_cancels_stale_audio_results_without_changing_authority', async ({ page, app }) => {
  await signIn(page, app);
  await page.goto(`${app.origin}/audiobooks`);
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let received!: () => void;
  const requested = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/books/libraries/*/items?*', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('category') !== 'books' || !url.searchParams.has('q')) return route.continue();
    const response = await route.fetch(); received(); await delayed; await route.fulfill({ response });
  });
  try {
    await page.getByRole('textbox', { name: 'Search audiobooks', exact: true }).fill('Tracks');
    await page.getByRole('textbox', { name: 'Search audiobooks', exact: true }).press('Enter');
    await requested;
    const toggle = page.getByRole('button', { name: 'Toggle menu', exact: true });
    if (await toggle.isVisible()) await toggle.click();
    await page.getByRole('navigation').getByRole('button', { name: 'Books', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Open Download-only Archive', exact: true })).toBeVisible();
    release();
    await expect(page.getByRole('link', { name: 'Open One Hundred and One Tracks', exact: true })).toHaveCount(0);
    const base = `${app.origin}/api/books/libraries/163ac435-50a9-4f56-96d0-276edf9303c1/items`;
    expect((await page.request.get(`${base}?category=ebooks&filter=multi`)).status()).toBe(400);
    expect((await page.request.get(`${base}?category=ebooks&q=${'x'.repeat(201)}`)).status()).toBe(400);
    expect((await page.request.get(`${app.origin}/api/books/libraries/unselected/items?category=ebooks`)).status()).toBe(404);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test.describe('large generated categories', () => {
  test.use({ categoryFixtures: true });
  test('saved_build_search_and_pagination_use_complete_role_inventory_before_paging', async ({ page, app }, info) => {
    // Isolate catalog pagination from the unchanged cover/read rate budget.
    await page.route('**/api/books/items/*/cover', route => route.fulfill({ status: 404, body: '' }));
    await signIn(page, app);
    for (const section of ['books', 'audiobooks'] as const) {
      await page.goto(`${app.origin}/${section}`);
      await expect(page.getByText(`3312 ${section} - Page 1`, { exact: true })).toBeVisible();
      await page.getByRole('textbox', { name: `Search ${section}`, exact: true }).fill('Generated 16');
      await page.getByRole('textbox', { name: `Search ${section}`, exact: true }).press('Enter');
      await expect(page.getByText(`110 ${section} - Page 1`, { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(50);
      await expect(page.getByRole('link', { name: 'Open Generated 1600 mixed', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Open Generated 1600 ebook', exact: true })).toHaveCount(section === 'books' ? 1 : 0);
      await expect(page.getByRole('link', { name: 'Open Generated 1600 single', exact: true })).toHaveCount(section === 'books' ? 0 : 1);
      await capture(page, `${section}-search-first-page`, info);
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await expect(page.getByText(`110 ${section} - Page 2`, { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(50);
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await expect(page.getByText(`110 ${section} - Page 3`, { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(10);
      await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
      await capture(page, `${section}-search-last-page`, info);
      await page.getByRole('combobox', { name: 'Sort', exact: true }).selectOption('author');
      await expect(page.getByText(`110 ${section} - Page 1`, { exact: true })).toBeVisible();
    }
    await fs.writeFile(info.outputPath('large-category-contract.json'), JSON.stringify({
      fixtureItems: 4968, books: 3312, audiobooks: 3312, nativeMatches: 165, matchesPerCategory: 110,
      pages: [50, 50, 10], categoryFilteringPrecedesPaging: true, covers: 'synthetic404, not cover-auth/rate/render proof',
    }, null, 2));
  });
});
