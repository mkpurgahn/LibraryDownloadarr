import fs, { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { Reader, Writer, ZipReader, Entry, configure } from '@zip.js/zip.js';
import { ArchiveBudget, EPUB_LIMITS, UnsafeEpub, validateArchiveName } from './manifest';
import { comicPages, prepareComic } from './comic';
import { ComicCommand, ComicEntryPlan, ComicReply, Coverage } from './progressiveTypes';

const data: { source: string; output: string; size: number } = workerData;
const budget = new ArchiveBudget(data.size, undefined, 'cbz');
let coverage: Coverage = [];
let file: FileHandle;
let zip: ZipReader<FileHandle>;
let entries: Entry[] = [];
let plans: ComicEntryPlan[] = [];
let busy = false;

class SpoolReader extends Reader<FileHandle> {
  override async init() { this.size = data.size; }
  override async readUint8Array(offset: number, length: number): Promise<Uint8Array> {
    if (![offset, length].every(Number.isSafeInteger) || offset < 0 || length < 0 || length > 64 * 1024 * 1024 ||
        offset + length > data.size || !coverage.some(([a, b]) => offset >= a && offset + length <= b)) {
      throw new UnsafeEpub('Archive attempted an uncommitted read');
    }
    budget.checkMemory(length);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await file.read(bytes, 0, length, offset);
    if (bytesRead !== length) throw new UnsafeEpub('Incomplete spool');
    return bytes;
  }
}
class PageWriter extends Writer<number> {
  private written = 0;
  constructor(private readonly destination: FileHandle) { super(); }
  override async writeUint8Array(chunk: Uint8Array) {
    budget.consume(chunk);
    let offset = 0;
    while (offset < chunk.length) {
      const { bytesWritten } = await this.destination.write(chunk, offset, chunk.length - offset);
      if (!bytesWritten) throw new UnsafeEpub('Page write failed');
      offset += bytesWritten;
    }
    this.written += chunk.length;
  }
  override async getData() { return this.written; }
}
async function execute(command: ComicCommand): Promise<Omit<ComicReply, 'metrics'>> {
  if (command.type === 'close') {
    await zip?.close(); await file?.close(); return {};
  }
  coverage = command.coverage;
  if (command.type === 'index') {
    if (zip) throw new UnsafeEpub('Duplicate index command');
    file = await fs.open(data.source, 'r');
    configure({ chunkSize: 65536, useWebWorkers: false, useCompressionStream: false });
    zip = new ZipReader(new SpoolReader(file), {
      strictness: 'strict', filenameValidation: 'strict', checkCrc32: true,
      useWebWorkers: false, useCompressionStream: false,
    });
    const names = new Set<string>();
    let declared = 0;
    for await (const entry of zip.getEntriesGenerator()) {
      if (entries.length >= EPUB_LIMITS.entries) throw new UnsafeEpub('Too many entries');
      const name = validateArchiveName(entry.filename);
      const folded = name.replace(/\/$/, '').toLowerCase();
      if (names.has(folded) || entry.encrypted || entry.symlink ||
          ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000 ||
          ![entry.offset, entry.compressedSize, entry.uncompressedSize].every(Number.isSafeInteger) ||
          entry.offset < 0 || entry.compressedSize < 0 || entry.uncompressedSize < 0 ||
          entry.uncompressedSize > EPUB_LIMITS.entryBytes || (entry.directory && entry.uncompressedSize !== 0)) {
        throw new UnsafeEpub('Unsafe directory entry');
      }
      names.add(folded); declared += entry.uncompressedSize;
      if (declared > EPUB_LIMITS.expandedBytes || declared > data.size * EPUB_LIMITS.ratio) throw new UnsafeEpub('Declared expansion exceeds budget');
      entries.push(entry);
      plans.push({ name, resourceId: createHash('sha256').update(name).digest('hex'),
        offset: entry.offset, compressedSize: entry.compressedSize, directory: entry.directory, end: 0 });
      budget.checkMemory();
    }
    const ordered = [...plans].sort((a, b) => a.offset - b.offset);
    for (let i = 0; i < ordered.length; i++) {
      ordered[i].end = ordered[i + 1]?.offset ?? command.directoryStart;
      if (ordered[i].offset + 30 + Buffer.byteLength(ordered[i].name) + ordered[i].compressedSize > ordered[i].end) {
        throw new UnsafeEpub('Overlapping archive records');
      }
    }
    const pages = comicPages(new Map(plans.map(p => [p.name, { id: p.resourceId, size: 0, directory: p.directory }])));
    pages.forEach(([name], index) => { plans.find(p => p.name === name)!.page = index + 1; });
    return { index: { entries: plans, spine: pages.map(([, entry]) => entry.id) } };
  }
  const entry = entries[command.index], plan = plans[command.index];
  if (!entry || !plan) throw new UnsafeEpub('Unknown entry');
  budget.beginEntry();
  if (entry.directory) return {};
  const filename = path.join(data.output, plan.resourceId);
  const destination = await fs.open(filename, 'wx', 0o600);
  let size: number;
  try {
    size = await entry.getData(new PageWriter(destination), { checkCrc32: true, useWebWorkers: false, useCompressionStream: false });
  } finally { await destination.close(); }
  if (size !== entry.uncompressedSize) throw new UnsafeEpub('Entry size mismatch');
  if (!plan.page) { await fs.rm(filename); return {}; }
  const resources = await prepareComic(new Map([[plan.name, { id: plan.resourceId, size }]]), data.output, budget);
  return { resource: resources[0] };
}
parentPort!.on('message', (command: ComicCommand) => {
  if (busy) throw new Error('Concurrent comic work rejected');
  busy = true;
  void execute(command).then(value => ({ ...value }),
    error => ({ error: error instanceof UnsafeEpub ? error.message : 'ZIP validation failed' })).then(value => {
    busy = false;
    parentPort!.postMessage({ ...value, metrics: {
      expandedBytes: budget.expandedBytes, peakTrackedBytes: budget.peakTrackedBytes, peakProcessRssBytes: budget.peakProcessRssBytes,
    } } satisfies ComicReply);
  });
});
