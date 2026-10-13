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

export type BookSummary = Omit<BookItem, 'files' | 'tracks' | 'chapters'> & {
  hasEbook: boolean;
  audioTrackCount: number;
};
export interface CatalogQuery {
  page: number;
  limit: number;
  filter: 'all' | 'ebook' | 'single' | 'multi';
  sort: 'title' | 'author';
  desc: boolean;
}
export interface CatalogPage {
  items: BookSummary[];
  page: number;
  limit: number;
  total: number;
}
export interface BooksConfig {
  enabled: boolean;
  providerInstanceId: string;
  configGeneration: number;
  origin: string;
  libraryId: string;
  serverBindingProofId: string;
}
