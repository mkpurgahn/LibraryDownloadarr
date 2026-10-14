import fs, { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { Reader, Writer, ZipReader, configure } from '@zip.js/zip.js';
import { SaxesParser } from 'saxes';
import * as css from 'css-tree';
import {
  ArchiveBudget, ArchiveFormat, ArchiveResult, CBZ_DOWNLOAD_ONLY_REASON, DOWNLOAD_ONLY_REASON, EPUB_LIMITS, PreparedResource, UnsafeEpub, validateArchiveName,
} from './manifest';
import type { StoredEntry } from './comic';

interface XmlNode {
  name: string;
  local: string;
  uri: string;
  attributes: Record<string, string>;
  children: Array<XmlNode | string>;
}
const OPF = 'http://www.idpf.org/2007/opf';
const XHTML = 'http://www.w3.org/1999/xhtml';
const resourceTypes = new Set([
  'application/xhtml+xml', 'text/html', 'text/css', 'image/svg+xml',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'font/woff', 'font/woff2', 'font/ttf', 'font/otf',
  'application/font-woff', 'application/vnd.ms-opentype', 'application/x-font-ttf',
  'application/x-dtbncx+xml',
]);
const excludedText = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'form']);

class DiskReader extends Reader<FileHandle> {
  constructor(private readonly file: FileHandle, private readonly budget: ArchiveBudget) { super(file); }
  override async init(): Promise<void> { this.size = (await this.file.stat()).size; }
  override async readUint8Array(offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
        length > 64 * 1024 * 1024) throw new UnsafeEpub('Archive read memory bound exceeded');
    const size = Math.min(length, Math.max(0, this.size - offset));
    this.budget.checkMemory(size);
    const data = Buffer.alloc(size);
    const { bytesRead } = await this.file.read(data, 0, size, offset);
    return data.subarray(0, bytesRead);
  }
}
class DiskWriter extends Writer<number> {
  private written = 0;
  constructor(private readonly file: FileHandle, private readonly budget: ArchiveBudget) { super(); }
  override async writeUint8Array(data: Uint8Array): Promise<void> {
    this.budget.consume(data);
    let offset = 0;
    while (offset < data.length) {
      const result = await this.file.write(data, offset, data.length - offset, null);
      if (!result.bytesWritten) throw new UnsafeEpub('Archive write failed');
      offset += result.bytesWritten;
    }
    this.written += data.length;
  }
  override async getData(): Promise<number> { return this.written; }
}

function parseXml(value: string, budget: ArchiveBudget): XmlNode {
  let root: XmlNode | undefined;
  const stack: XmlNode[] = [];
  let count = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', value => { if (value.trim().toLowerCase() !== 'html') throw new UnsafeEpub('DTDs are unsupported'); });
  parser.on('error', () => { throw new UnsafeEpub('Invalid XML'); });
  parser.on('opentag', tag => {
    count += 1;
    if (count > EPUB_LIMITS.xmlNodes || stack.length >= EPUB_LIMITS.xmlDepth) throw new UnsafeEpub('XML structure bound exceeded');
    const attributes = Object.fromEntries(Object.values(tag.attributes).map(attribute => {
      if (attribute.value.length > 65536) throw new UnsafeEpub('XML attribute bound exceeded');
      return [attribute.name, attribute.value];
    }));
    const node: XmlNode = { name: tag.name, local: tag.local.toLowerCase(), uri: tag.uri, attributes, children: [] };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (root) throw new UnsafeEpub('Ambiguous XML root');
    else root = node;
    stack.push(node);
    if (count % 1000 === 0) budget.checkMemory();
  });
  const text = (value: string) => {
    if (stack.length) stack[stack.length - 1].children.push(value);
  };
  parser.on('text', text); parser.on('cdata', text);
  parser.on('closetag', () => { stack.pop(); });
  parser.write(value).close();
  if (!root || stack.length) throw new UnsafeEpub('Incomplete XML');
  return root;
}
function elements(node: XmlNode): XmlNode[] {
  const result: XmlNode[] = [node];
  for (const child of node.children) if (typeof child !== 'string') result.push(...elements(child));
  return result;
}
function textContent(node: XmlNode, safe = false): string {
  if (safe && excludedText.has(node.local)) return '';
  return node.children.map(child => typeof child === 'string' ? child : textContent(child, safe)).join('');
}
const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const serialize = (node: XmlNode): string => `<${node.name}${Object.entries(node.attributes).map(([name, value]) =>
  ` ${name}="${escapeText(value).replace(/"/g, '&quot;')}"`).join('')}>${node.children.map(child =>
  typeof child === 'string' ? escapeText(child) : serialize(child)).join('')}</${node.name}>`;

function resolveReference(from: string, href: string): { name: string; fragment?: string } {
  if (!href || /^[a-z][a-z0-9+.-]*:|^[\\/]/i.test(href) || href.includes('?')) throw new UnsafeEpub('External resource reference');
  const hash = href.indexOf('#');
  const location = hash >= 0 ? href.slice(0, hash) : href;
  const fragment = hash >= 0 ? decodeURIComponent(href.slice(hash + 1)) : undefined;
  const decoded = decodeURIComponent(location).normalize('NFC');
  if (decoded.includes('\\') || /^[\\/]|^[A-Za-z]:/.test(decoded) || /[\u0000-\u001f]/.test(decoded)) throw new UnsafeEpub('Unsafe resource reference');
  const name = validateArchiveName(location ? path.posix.join(path.posix.dirname(from), decoded) : from);
  if (fragment !== undefined && (fragment.length > 1000 || /[\u0000-\u001f]/.test(fragment))) throw new UnsafeEpub('Unsafe fragment');
  return { name, ...(fragment ? { fragment } : {}) };
}
function internalReference(from: string, href: string, resources: Map<string, PreparedResource>): string {
  try {
    const resolved = resolveReference(from, href);
    const resource = resources.get(resolved.name);
    if (!resource) return 'about:invalid';
    return `book-resource:${resource.resourceId}${resolved.fragment ? `#${encodeURIComponent(resolved.fragment)}` : ''}`;
  } catch { return 'about:invalid'; }
}
function rewriteCss(value: string, from: string, resources: Map<string, PreparedResource>): string {
  if (value.length > 512 * 1024) throw new UnsafeEpub('Stylesheet bound exceeded');
  const tree = css.parse(value, { positions: false });
  css.walk(tree, node => {
    if (node.type === 'Url') node.value = internalReference(from, node.value, resources);
  });
  return css.generate(tree);
}

async function processArchive(source: string, output: string, format: ArchiveFormat): Promise<ArchiveResult> {
  const started = performance.now();
  const stat = await fs.stat(source);
  const budget = new ArchiveBudget(stat.size);
  const entries = new Map<string, StoredEntry>();
  const foldedNames = new Set<string>();
  let file: FileHandle | undefined;
  let zip: ZipReader<FileHandle> | undefined;
  const result = (): ArchiveResult => ({
    state: 'download-only', resources: [], spine: [], toc: [],
    reason: format === 'cbz' ? CBZ_DOWNLOAD_ONLY_REASON : DOWNLOAD_ONLY_REASON,
    metrics: { entries: budget.entries, expandedBytes: budget.expandedBytes, peakTrackedBytes: budget.peakTrackedBytes,
      peakProcessRssBytes: budget.peakProcessRssBytes, elapsedMs: performance.now() - started },
  });
  try {
    await fs.mkdir(output, { recursive: true, mode: 0o700 });
    file = await fs.open(source, 'r');
    configure({ chunkSize: 65536, useWebWorkers: false, useCompressionStream: false });
    zip = new ZipReader(new DiskReader(file, budget), {
      useWebWorkers: false, useCompressionStream: false,
      strictness: 'strict', filenameValidation: 'strict', checkCrc32: true,
    });
    for await (const entry of zip.getEntriesGenerator()) {
      budget.beginEntry();
      const name = validateArchiveName(entry.filename);
      const folded = name.replace(/\/$/, '').toLowerCase();
      if (entries.has(name) || (format === 'cbz' && foldedNames.has(folded)) || entry.encrypted || entry.symlink ||
          ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new UnsafeEpub('Unsafe or encrypted archive entry');
      foldedNames.add(folded);
      if (entry.uncompressedSize > EPUB_LIMITS.entryBytes) throw new UnsafeEpub('Expanded entry limit exceeded');
      const id = createHash('sha256').update(name).digest('hex');
      if (entry.directory) { entries.set(name, { id, size: 0, directory: true }); continue; }
      const destination = await fs.open(path.join(output, id), 'wx', 0o600);
      try {
        const writer = new DiskWriter(destination, budget);
        const size = await entry.getData(writer, { useWebWorkers: false, useCompressionStream: false, checkCrc32: true });
        entries.set(name, { id, size });
      } finally { await destination.close(); }
    }
    if (format === 'cbz') {
      const { prepareComic, comicDecoderLimits } = await import('./comic');
      const resources = await prepareComic(entries, output, budget);
      return { ...result(), state: 'ready', reason: undefined, resources,
        spine: resources.map(resource => resource.resourceId), toc: [],
        metrics: { ...result().metrics, ...comicDecoderLimits() } };
    }
    if (entries.has('META-INF/encryption.xml')) throw new UnsafeEpub('Unsupported EPUB encryption');
    const readText = async (name: string, max = EPUB_LIMITS.entryBytes): Promise<string> => {
      const entry = entries.get(name);
      if (!entry || entry.size > max) throw new UnsafeEpub('Missing or oversized EPUB document');
      budget.checkMemory(entry.size * 4);
      const data = await fs.readFile(path.join(output, entry.id));
      const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
      return new TextDecoder(encoding, { fatal: true }).decode(data);
    };
    if ((await readText('mimetype', 100)).trim() !== 'application/epub+zip') throw new UnsafeEpub('Not an EPUB');
    const container = parseXml(await readText('META-INF/container.xml', 1024 * 1024), budget);
    if (container.local !== 'container' || container.uri !== 'urn:oasis:names:tc:opendocument:xmlns:container') throw new UnsafeEpub('Invalid EPUB container');
    const roots = elements(container).filter(node => node.local === 'rootfile' && node.attributes['media-type'] === 'application/oebps-package+xml');
    if (roots.length !== 1) throw new UnsafeEpub('Ambiguous EPUB package');
    const packageName = validateArchiveName(decodeURIComponent(roots[0].attributes['full-path'] ?? ''));
    const packageNode = parseXml(await readText(packageName, 1024 * 1024), budget);
    if (packageNode.local !== 'package' || packageNode.uri !== OPF) throw new UnsafeEpub('Invalid EPUB package');
    const packageNodes = elements(packageNode);
    if (packageNodes.some(node => node.local === 'meta' &&
      node.attributes.property === 'rendition:layout' && textContent(node).trim() === 'pre-paginated')) throw new UnsafeEpub('Fixed layout unsupported');
    const manifest = packageNodes.filter(node => node.local === 'item' && node.uri === OPF);
    const resources = new Map<string, PreparedResource>();
    const byId = new Map<string, { name: string; resource: PreparedResource }>();
    let navName: string | undefined;
    for (const node of manifest) {
      const properties = (node.attributes.properties ?? '').split(/\s+/);
      if (properties.some(value => ['scripted', 'remote-resources'].includes(value))) throw new UnsafeEpub('Interactive rendition unsupported');
      const mediaType = node.attributes['media-type'];
      const id = node.attributes.id;
      if (!id || byId.has(id) || !resourceTypes.has(mediaType)) throw new UnsafeEpub('Unsupported or ambiguous manifest');
      const { name } = resolveReference(packageName, node.attributes.href);
      const stored = entries.get(name);
      if (!stored || resources.has(name)) throw new UnsafeEpub('Manifest resource unavailable');
      const resource: PreparedResource = { resourceId: stored.id, mediaType, size: stored.size };
      resources.set(name, resource); byId.set(id, { name, resource });
      if (properties.includes('nav')) {
        if (navName) throw new UnsafeEpub('Multiple navigation documents');
        navName = name;
      }
    }
    const spineNode = packageNodes.filter(node => node.local === 'spine' && node.uri === OPF);
    if (spineNode.length !== 1) throw new UnsafeEpub('Invalid EPUB spine');
    const spine = elements(spineNode[0]).filter(node => node.local === 'itemref' && node.uri === OPF).map(node => {
      const entry = byId.get(node.attributes.idref);
      if (!entry || !['application/xhtml+xml', 'text/html'].includes(entry.resource.mediaType)) throw new UnsafeEpub('Invalid EPUB spine');
      return entry.resource.resourceId;
    });
    if (!spine.length || new Set(spine).size !== spine.length) throw new UnsafeEpub('Empty or ambiguous EPUB spine');
    const toc: ArchiveResult['toc'] = [];
    if (!navName && spineNode[0].attributes.toc) {
      const entry = byId.get(spineNode[0].attributes.toc);
      if (!entry || entry.resource.mediaType !== 'application/x-dtbncx+xml') throw new UnsafeEpub('Invalid navigation document');
      const ncx = parseXml(await readText(entry.name, 1024 * 1024), budget);
      if (ncx.local !== 'ncx' || ncx.uri !== 'http://www.daisy.org/z3986/2005/ncx/') throw new UnsafeEpub('Invalid navigation document');
      for (const point of elements(ncx).filter(node => node.local === 'navpoint')) {
        const children = point.children.filter((node): node is XmlNode => typeof node !== 'string');
        const content = children.find(node => node.local === 'content');
        const label = children.find(node => node.local === 'navlabel');
        if (!content || !label) throw new UnsafeEpub('Invalid navigation entry');
        const resolved = resolveReference(entry.name, content.attributes.src);
        const destination = resources.get(resolved.name);
        if (!destination || !spine.includes(destination.resourceId)) throw new UnsafeEpub('Invalid navigation target');
        toc.push({ title: textContent(label).trim().slice(0, 500), resourceId: destination.resourceId, ...(resolved.fragment ? { fragment: resolved.fragment } : {}) });
      }
    }
    for (const [name, resource] of resources) {
      if (!['application/xhtml+xml', 'text/html', 'image/svg+xml', 'text/css'].includes(resource.mediaType)) continue;
      const value = await readText(name);
      let rewritten: string;
      if (resource.mediaType === 'text/css') rewritten = rewriteCss(value, name, resources);
      else {
        const document = parseXml(value, budget);
        if (resource.mediaType !== 'image/svg+xml' && (document.local !== 'html' || document.uri !== XHTML)) throw new UnsafeEpub('Invalid content document');
        const nodes = elements(document);
        if (name === navName) {
          const nav = nodes.find(node => node.local === 'nav' && (node.attributes['epub:type'] ?? '').split(/\s+/).includes('toc'));
          if (!nav) throw new UnsafeEpub('Missing table of contents');
          for (const link of elements(nav).filter(node => node.local === 'a' && node.attributes.href)) {
            const resolved = resolveReference(name, link.attributes.href);
            const destination = resources.get(resolved.name);
            if (!destination || !spine.includes(destination.resourceId)) throw new UnsafeEpub('Invalid table of contents target');
            toc.push({ title: textContent(link).trim().slice(0, 500), resourceId: destination.resourceId, ...(resolved.fragment ? { fragment: resolved.fragment } : {}) });
          }
        }
        if (spine.includes(resource.resourceId)) {
          const body = nodes.find(node => node.local === 'body');
          if (!body) throw new UnsafeEpub('Missing section body');
          resource.textLength = textContent(body, true).length;
          if (resource.textLength > EPUB_LIMITS.sectionCharacters) throw new UnsafeEpub('Section text bound exceeded');
        }
        for (const node of nodes) {
          for (const attribute of ['href', 'src', 'xlink:href', 'poster']) {
            if (node.attributes[attribute]) node.attributes[attribute] = internalReference(name, node.attributes[attribute], resources);
          }
          if (node.attributes.srcset) delete node.attributes.srcset;
          if (node.attributes.style) {
            const tree = css.parse(node.attributes.style, { context: 'declarationList' });
            css.walk(tree, entry => { if (entry.type === 'Url') entry.value = internalReference(name, entry.value, resources); });
            node.attributes.style = css.generate(tree);
          }
          if (node.local === 'style') node.children = [rewriteCss(textContent(node), name, resources)];
        }
        rewritten = serialize(document);
      }
      const data = Buffer.from(rewritten, 'utf8');
      if (data.length > EPUB_LIMITS.entryBytes) throw new UnsafeEpub('Prepared resource limit exceeded');
      budget.checkMemory(data.length);
      await fs.writeFile(path.join(output, resource.resourceId), data);
      resource.size = data.length;
    }
    if (!toc.length) spine.forEach((resourceId, index) => toc.push({ title: `Section ${index + 1}`, resourceId }));
    const preparedBytes = [...resources.values()].reduce((sum, resource) => sum + resource.size, 0);
    if (preparedBytes > EPUB_LIMITS.expandedBytes) throw new UnsafeEpub('Prepared aggregate limit exceeded');
    const retained = new Set([...resources.values()].map(resource => resource.resourceId));
    for (const entry of entries.values()) if (!retained.has(entry.id)) await fs.rm(path.join(output, entry.id), { force: true });
    budget.checkMemory();
    return { ...result(), state: 'ready', reason: undefined, resources: [...resources.values()], spine, toc };
  } catch (error) {
    return { ...result(), failureCode: error instanceof UnsafeEpub ? (format === 'cbz' ? 'UNSAFE_CBZ' : 'UNSAFE_EPUB') : 'WORKER_FAILURE' };
  } finally {
    await zip?.close();
    await file?.close();
  }
}

if (parentPort) {
  const input: unknown = workerData;
  if (!input || typeof input !== 'object' || !('source' in input) || !('output' in input) ||
      typeof input.source !== 'string' || typeof input.output !== 'string') throw new Error('Invalid worker input');
  const format = 'format' in input && input.format === 'cbz' ? 'cbz' : 'epub';
  void processArchive(input.source, input.output, format).then(
    result => parentPort!.postMessage(result),
    () => parentPort!.postMessage({
      state: 'download-only', resources: [], spine: [], toc: [], reason: format === 'cbz' ? CBZ_DOWNLOAD_ONLY_REASON : DOWNLOAD_ONLY_REASON,
      failureCode: 'WORKER_FAILURE',
      metrics: { entries: 0, expandedBytes: 0, peakTrackedBytes: 0, elapsedMs: 0 },
    } satisfies ArchiveResult)
  );
}
