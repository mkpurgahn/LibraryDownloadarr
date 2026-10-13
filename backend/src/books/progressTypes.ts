import { createHash } from 'node:crypto';
import { BookItem, BookKey } from './types';
import { invalidInput, opaqueSegment } from './limits';

export type EbookLocator =
  { kind: 'epub'; resourceId: string; textOffset: number; fraction: number; policyVersion: string } |
  { kind: 'pdf'; page: number; offset: number };
export interface AudioLocator {
  kind: 'audio';
  trackId: string;
  localSeconds: number;
  globalSeconds: number;
}
export interface ProgressKey extends BookKey {
  userId: string;
  mode: 'ebook' | 'audio';
  editionId: string;
}
export interface Progress {
  key: ProgressKey;
  contentVersion: string;
  locator: EbookLocator | AudioLocator;
  revision: number;
  writerId: string;
  epoch: number;
  sequence: number;
  updatedAt: number;
  completed: boolean;
}
export interface ProgressWrite {
  op: 'claim' | 'save';
  contentVersion: string;
  expectedRevision: number;
  writerId: string;
  epoch?: number;
  sequence: number;
  locator: EbookLocator | AudioLocator;
  completed?: boolean;
}
export type ProgressResult = { status: 'saved'; value: Progress } |
  { status: 'conflict' | 'incompatible'; canonical: Progress | undefined };

export function audioEdition(item: BookItem): { editionId: string; contentVersion: string } | undefined {
  if (item.missing || item.invalid || !item.tracks.length) return undefined;
  const files = new Map(item.files.map(file => [file.fileId, file]));
  const tracks = [];
  let end = 0;
  for (const track of item.tracks) {
    const file = files.get(track.fileId);
    if (!file?.available || file.role !== 'audio' || !Number.isFinite(track.duration) || track.duration <= 0 ||
        !Number.isFinite(track.startOffset) || Math.abs(track.startOffset - end) > 0.05) return undefined;
    tracks.push([track.fileId, file.contentVersion, track.duration, track.startOffset]);
    end = track.startOffset + track.duration;
  }
  const version = createHash('sha256').update(JSON.stringify([
    item.providerInstanceId, item.libraryId, item.itemId, tracks,
  ])).digest('hex');
  return { editionId: `audio_${version}`, contentVersion: version };
}

const finite = (value: unknown, min = 0, max = Number.MAX_VALUE): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const integer = (value: unknown, min = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

export function progressLocator(input: unknown): EbookLocator | AudioLocator {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidInput();
  const value = input as Record<string, unknown>;
  if (value.kind === 'pdf') {
    if (Object.keys(value).some(key => !['kind', 'page', 'offset'].includes(key)) ||
        !integer(value.page, 1) || value.page > 5000 || !finite(value.offset, 0, 1)) throw invalidInput();
    return { kind: 'pdf', page: value.page, offset: value.offset };
  }
  if (value.kind === 'audio') {
    if (Object.keys(value).some(key => !['kind', 'trackId', 'localSeconds', 'globalSeconds'].includes(key)) ||
        !finite(value.localSeconds) || !finite(value.globalSeconds)) throw invalidInput();
    return { kind: 'audio', trackId: opaqueSegment(value.trackId), localSeconds: value.localSeconds, globalSeconds: value.globalSeconds };
  }
  if (value.kind === 'epub') {
    if (Object.keys(value).some(key => !['kind', 'resourceId', 'textOffset', 'fraction', 'policyVersion'].includes(key)) ||
        !integer(value.textOffset) || value.textOffset > 32 * 1024 * 1024 || !finite(value.fraction, 0, 1)) throw invalidInput();
    return {
      kind: 'epub', resourceId: opaqueSegment(value.resourceId), textOffset: value.textOffset,
      fraction: value.fraction, policyVersion: opaqueSegment(value.policyVersion),
    };
  }
  throw invalidInput();
}

export function progressWrite(input: unknown): ProgressWrite {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidInput();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['op', 'contentVersion', 'expectedRevision', 'writerId', 'epoch', 'sequence', 'locator', 'completed'].includes(key)) ||
      (value.op !== 'claim' && value.op !== 'save') || !integer(value.expectedRevision) || !integer(value.sequence, 1) ||
      (value.epoch !== undefined && !integer(value.epoch, 1)) ||
      (value.completed !== undefined && typeof value.completed !== 'boolean')) throw invalidInput();
  return {
    op: value.op, contentVersion: opaqueSegment(value.contentVersion), expectedRevision: value.expectedRevision,
    writerId: opaqueSegment(value.writerId), sequence: value.sequence,
    ...(value.epoch !== undefined ? { epoch: value.epoch } : {}),
    locator: progressLocator(value.locator),
    ...(value.completed !== undefined ? { completed: value.completed } : {}),
  };
}
