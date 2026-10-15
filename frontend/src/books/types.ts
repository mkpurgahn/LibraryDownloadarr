export interface BookKey {
  providerInstanceId: string;
  libraryId: string;
  itemId: string;
}
export interface BookFile {
  fileId: string;
  basename: string;
  role: 'ebook' | 'audio';
  extension: string;
  size: number;
  mime: string;
  available: boolean;
  contentVersion: string;
}
export interface BookItem extends BookKey {
  title: string;
  authors: string[];
  narrators: string[];
  series: string[];
  description: string;
  missing: boolean;
  invalid: boolean;
  files: BookFile[];
  tracks: Array<{ fileId: string; duration: number; startOffset: number }>;
  chapters: Array<{ id: string; title: string; start: number; end: number }>;
  read: { available: boolean; reason?: string };
  listen: { available: boolean; reason?: string };
  audioEdition?: { editionId: string; contentVersion: string };
}
export type BookSummary = Omit<BookItem, 'files' | 'tracks' | 'chapters'> & { hasEbook: boolean; audioTrackCount: number };
export interface BookTarget { itemId: string; fileId: string; contentVersion: string }
export const READ_LIMITS = { epub: 100 * 1024 * 1024, pdf: 512 * 1024 * 1024, cbz: 256 * 1024 * 1024 } as const;
export const COMIC_LIMITS = { pages: 1000, pixels: 16000000, dimension: 8192, entryBytes: 32 * 1024 * 1024 } as const;
export interface BookTicketResult {
  target: BookTarget;
  ticket?: { url: string; expiresAt: number; filename: string; size: number; resumable: boolean };
  error?: { status: number; code: string };
}
export interface BooksLibrary { providerInstanceId: string; libraryId: string; name: string }
export type BookCategory = 'books' | 'audiobooks';
export interface CatalogQuery {
  page: number; limit: number; filter: 'all' | 'ebook' | 'single' | 'multi'; sort: 'title' | 'author'; desc: boolean;
  category?: 'books' | 'ebooks';
  q?: string;
}
export interface CatalogPage { items: BookSummary[]; page: number; limit: number; total: number }
export interface BooksSettingsState {
  configured: boolean;
  enabled: boolean;
  deploymentEnabled: boolean;
  libraryId: string;
  providerInstanceId?: string;
  configGeneration: number;
  serverBindingProofId?: string;
}

export const invalidResponse = () => new Error('The Books service returned an invalid response.');
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 10000): string {
  if (typeof value !== 'string' || value.length > max) throw invalidResponse();
  return value;
}
export function id(value: unknown): string {
  const result = text(value, 200);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw invalidResponse();
  return result;
}
export function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidResponse();
  return value;
}
export function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalidResponse();
  return value;
}
export function integer(value: unknown): number {
  const result = finite(value);
  if (!Number.isSafeInteger(result)) throw invalidResponse();
  return result;
}
export function list(value: unknown, max = 10000): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalidResponse();
  return value;
}
function action(value: unknown): BookItem['read'] {
  const raw = record(value);
  return { available: flag(raw.available), ...(raw.reason === undefined ? {} : { reason: text(raw.reason, 500) }) };
}
function common(raw: Record<string, unknown>): Omit<BookItem, 'files' | 'tracks' | 'chapters'> {
  const edition = raw.audioEdition === undefined ? undefined : record(raw.audioEdition);
  return {
    providerInstanceId: id(raw.providerInstanceId), libraryId: id(raw.libraryId), itemId: id(raw.itemId),
    title: text(raw.title, 1000), authors: list(raw.authors, 1000).map(name => text(name, 1000)),
    narrators: list(raw.narrators, 1000).map(name => text(name, 1000)),
    series: list(raw.series, 1000).map(name => text(name, 1000)), description: text(raw.description),
    missing: flag(raw.missing), invalid: flag(raw.invalid), read: action(raw.read), listen: action(raw.listen),
    ...(edition ? { audioEdition: { editionId: id(edition.editionId), contentVersion: id(edition.contentVersion) } } : {}),
  };
}
export function parseBookSummary(value: unknown): BookSummary {
  const raw = record(value);
  return { ...common(raw), hasEbook: flag(raw.hasEbook), audioTrackCount: integer(raw.audioTrackCount) };
}
export function parseBookItem(value: unknown): BookItem {
  const raw = record(value);
  const files = list(raw.files).map((value): BookFile => {
    const file = record(value);
    if (file.role !== 'ebook' && file.role !== 'audio') throw invalidResponse();
    return {
      fileId: id(file.fileId), basename: text(file.basename, 255), role: file.role,
      extension: text(file.extension, 20), size: integer(file.size), mime: text(file.mime, 100),
      available: flag(file.available), contentVersion: id(file.contentVersion),
    };
  });
  const ids = new Set(files.map(file => file.fileId));
  if (ids.size !== files.length) throw invalidResponse();
  const tracks = list(raw.tracks).map(value => {
    const track = record(value);
    const fileId = id(track.fileId);
    if (!ids.has(fileId)) throw invalidResponse();
    return { fileId, duration: finite(track.duration), startOffset: finite(track.startOffset) };
  });
  const chapters = list(raw.chapters).map(value => {
    const chapter = record(value);
    return { id: text(chapter.id, 200), title: text(chapter.title, 500), start: finite(chapter.start), end: finite(chapter.end) };
  });
  return { ...common(raw), files, tracks, chapters };
}
export function parseCatalog(value: unknown): CatalogPage {
  const raw = record(value);
  const limit = integer(raw.limit);
  if (limit < 1 || limit > 100) throw invalidResponse();
  return { items: list(raw.items, limit).map(parseBookSummary), page: integer(raw.page), limit, total: integer(raw.total) };
}

interface ReaderManifest {
  readerId: string;
  state: 'preparing' | 'ready' | 'download-only';
  contentVersion: string;
  spine: string[];
  toc: Array<{ title: string; resourceId: string; fragment?: string }>;
  reason?: string;
}
export interface ReaderResource { resourceId: string; mediaType: string; size: number }
export interface ComicResource extends ReaderResource { width: number; height: number }
export interface EpubDescriptor extends ReaderManifest {
  policyVersion: 'epub-scroll-v1';
  resources: ReaderResource[];
}
export interface ComicDescriptor extends ReaderManifest {
  policyVersion: 'cbz-pages-v1';
  resources: ComicResource[];
}
export type ReaderDescriptor = EpubDescriptor | ComicDescriptor;
export interface ProgressiveComicDescriptor {
  protocol: 'cbz-progressive-v1'; policyVersion: 'cbz-pages-v1';
  readerId: string; contentVersion: string; revision: number;
  state: 'preparing' | 'complete' | 'failed'; mode: 'range' | 'full-download';
  spine: string[]; resources: ComicResource[];
  pages: Array<{ resourceId: string; state: 'pending' | 'validating' | 'ready' | 'failed' }>;
  reason?: string;
}
export function parseProgressiveComic(value: unknown): ProgressiveComicDescriptor {
  const raw = record(value);
  if (raw.protocol !== 'cbz-progressive-v1' || raw.policyVersion !== 'cbz-pages-v1' ||
      (raw.state !== 'preparing' && raw.state !== 'complete' && raw.state !== 'failed') ||
      (raw.mode !== 'range' && raw.mode !== 'full-download')) throw invalidResponse();
  const entries = list(raw.resources, COMIC_LIMITS.pages);
  const ready = parseReader({ ...raw, state: 'preparing', spine: entries.map(e => record(e).resourceId), toc: [] });
  if (ready.policyVersion !== 'cbz-pages-v1') throw invalidResponse();
  const spine = list(raw.spine, COMIC_LIMITS.pages).map(id);
  const ids = new Set(spine);
  if (ids.size !== spine.length || spine.some(id => !/^[a-f0-9]{64}$/.test(id)) ||
      ready.resources.some(r => !ids.has(r.resourceId)) ||
      (raw.state === 'complete' && (!spine.length || ready.resources.length !== spine.length))) throw invalidResponse();
  const pages = list(raw.pages, COMIC_LIMITS.pages).map((value, index): ProgressiveComicDescriptor['pages'][number] => {
    const page = record(value);
    if (page.resourceId !== spine[index] ||
        (page.state !== 'pending' && page.state !== 'validating' && page.state !== 'ready' && page.state !== 'failed') ||
        (page.state === 'ready') !== ready.resources.some(r => r.resourceId === page.resourceId)) throw invalidResponse();
    return { resourceId: id(page.resourceId), state: page.state };
  });
  if (pages.length !== spine.length) throw invalidResponse();
  return { protocol: raw.protocol, policyVersion: raw.policyVersion, readerId: ready.readerId,
    contentVersion: ready.contentVersion, revision: integer(raw.revision), spine, resources: ready.resources, pages,
    state: raw.state, mode: raw.mode,
    ...(raw.reason === undefined ? {} : { reason: text(raw.reason, 500) }) };
}
export function parseReader(value: unknown): ReaderDescriptor {
  const raw = record(value);
  if ((raw.state !== 'preparing' && raw.state !== 'ready' && raw.state !== 'download-only') ||
      (raw.policyVersion !== 'epub-scroll-v1' && raw.policyVersion !== 'cbz-pages-v1')) throw invalidResponse();
  const resources = list(raw.resources).map(value => {
    const resource = record(value);
    const resourceId = id(resource.resourceId);
    const size = integer(resource.size);
    if (!/^[a-f0-9]{64}$/.test(resourceId) || size > 32 * 1024 * 1024) throw invalidResponse();
    return { resourceId, size, mediaType: text(resource.mediaType, 100) };
  });
  const ids = new Set(resources.map(resource => resource.resourceId));
  const spine = list(raw.spine).map(id);
  if (ids.size !== resources.length || new Set(spine).size !== spine.length ||
      spine.some(id => !ids.has(id)) || (raw.state === 'ready' && !spine.length)) throw invalidResponse();
  const manifest: ReaderManifest = {
    readerId: id(raw.readerId), state: raw.state,
    contentVersion: id(raw.contentVersion), spine,
    toc: list(raw.toc).map(value => {
      const entry = record(value);
      const resourceId = id(entry.resourceId);
      if (!spine.includes(resourceId)) throw invalidResponse();
      return { resourceId, title: text(entry.title, 500), ...(entry.fragment === undefined ? {} : { fragment: text(entry.fragment, 1000) }) };
    }),
    ...(raw.reason === undefined ? {} : { reason: text(raw.reason, 500) }),
  };
  if (raw.policyVersion === 'cbz-pages-v1') {
    const pages = list(raw.resources, COMIC_LIMITS.pages).map((value, index): ComicResource => {
      const page = record(value);
      const width = integer(page.width); const height = integer(page.height);
      if (!width || !height || width > COMIC_LIMITS.dimension || height > COMIC_LIMITS.dimension ||
          width * height > COMIC_LIMITS.pixels || !['image/png', 'image/jpeg', 'image/webp'].includes(resources[index].mediaType)) throw invalidResponse();
      return { ...resources[index], width, height };
    });
    if (spine.length !== pages.length || pages.reduce((sum, page) => sum + page.size, 0) > 512 * 1024 * 1024) throw invalidResponse();
    return { ...manifest, policyVersion: raw.policyVersion, resources: pages };
  }
  return { ...manifest, policyVersion: raw.policyVersion, resources };
}

export interface ComicLocator { kind: 'cbz'; page: number; offset: number; horizontal: number; policyVersion: string }
export type EbookLocator =
  { kind: 'epub'; resourceId: string; textOffset: number; fraction: number; policyVersion: string } |
  ComicLocator |
  { kind: 'pdf'; page: number; offset: number };
export interface AudioLocator { kind: 'audio'; trackId: string; localSeconds: number; globalSeconds: number }
export interface Progress {
  key: BookKey & { userId: string; mode: 'ebook' | 'audio'; editionId: string };
  contentVersion: string; locator: EbookLocator | AudioLocator; revision: number;
  writerId: string; epoch: number; sequence: number; updatedAt: number; completed: boolean;
}
export interface ProgressWrite {
  op: 'claim' | 'save'; contentVersion: string; expectedRevision: number;
  writerId: string; epoch?: number; sequence: number; locator: EbookLocator | AudioLocator; completed?: boolean;
}
export function parseLocator(value: unknown): EbookLocator | AudioLocator {
  const raw = record(value);
  if (raw.kind === 'cbz') {
    const page = integer(raw.page); const offset = finite(raw.offset); const horizontal = finite(raw.horizontal);
    if (!page || page > COMIC_LIMITS.pages || offset > 1 || horizontal > 1) throw invalidResponse();
    return { kind: 'cbz', page, offset, horizontal, policyVersion: id(raw.policyVersion) };
  }
  if (raw.kind === 'epub') {
    const fraction = finite(raw.fraction); const textOffset = integer(raw.textOffset);
    if (fraction > 1 || textOffset > 1024 * 1024 || raw.policyVersion !== 'epub-scroll-v1') throw invalidResponse();
    return { kind: 'epub', resourceId: id(raw.resourceId), textOffset, fraction, policyVersion: raw.policyVersion };
  }
  if (raw.kind === 'pdf') {
    const page = integer(raw.page); const offset = finite(raw.offset);
    if (page < 1 || page > 5000 || offset > 1) throw invalidResponse();
    return { kind: 'pdf', page, offset };
  }
  if (raw.kind === 'audio') return { kind: 'audio', trackId: id(raw.trackId), localSeconds: finite(raw.localSeconds), globalSeconds: finite(raw.globalSeconds) };
  throw invalidResponse();
}
export function parseProgress(value: unknown): Progress {
  const raw = record(value); const key = record(raw.key);
  if (key.mode !== 'ebook' && key.mode !== 'audio') throw invalidResponse();
  return {
    key: { providerInstanceId: id(key.providerInstanceId), libraryId: id(key.libraryId), itemId: id(key.itemId),
      userId: id(key.userId), mode: key.mode, editionId: id(key.editionId) },
    contentVersion: id(raw.contentVersion), locator: parseLocator(raw.locator), revision: integer(raw.revision),
    writerId: id(raw.writerId), epoch: integer(raw.epoch), sequence: integer(raw.sequence),
    updatedAt: integer(raw.updatedAt), completed: flag(raw.completed),
  };
}
