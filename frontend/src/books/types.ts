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
export interface BookTicketResult {
  target: BookTarget;
  ticket?: { url: string; expiresAt: number; filename: string; size: number; resumable: boolean };
  error?: { status: number; code: string };
}
export interface BooksLibrary { providerInstanceId: string; libraryId: string; name: string }
export interface CatalogQuery {
  page: number; limit: number; filter: 'all' | 'ebook' | 'single' | 'multi'; sort: 'title' | 'author'; desc: boolean;
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
