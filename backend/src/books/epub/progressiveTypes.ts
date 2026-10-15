import { PreparedResource } from './manifest';

export const PROGRESSIVE_LIMITS = {
  processingMs: 30000, deadlineMs: 300000, leaseMs: 60000, pollMs: 2000,
  blockBytes: 256 * 1024, overheadBytes: 16 * 1024 * 1024, requests: 8192,
} as const;
export interface ProgressiveDescriptor {
  protocol: 'cbz-progressive-v1';
  revision: number;
  readerId: string;
  policyVersion: 'cbz-pages-v1';
  contentVersion: string;
  state: 'preparing' | 'complete' | 'failed';
  mode: 'range' | 'full-download';
  spine: string[];
  resources: PreparedResource[];
  pages: Array<{ resourceId: string; state: 'pending' | 'validating' | 'ready' | 'failed' }>;
  activePage?: number;
  reason?: string;
}
export interface ComicEntryPlan {
  name: string; resourceId: string; offset: number; compressedSize: number;
  end: number; directory: boolean; page?: number;
}
export interface ComicIndex { entries: ComicEntryPlan[]; spine: string[] }
export type Coverage = Array<[number, number]>;
export type ComicCommand =
  { type: 'index'; coverage: Coverage; directoryStart: number } |
  { type: 'entry'; coverage: Coverage; index: number } |
  { type: 'close' };
export interface ComicReply {
  index?: ComicIndex;
  resource?: PreparedResource;
  error?: string;
  metrics: { expandedBytes: number; peakTrackedBytes: number; peakProcessRssBytes: number };
}
