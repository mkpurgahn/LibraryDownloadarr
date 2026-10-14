import { fromRange, toRange, parse as parseCfi } from 'foliate-js/epubcfi.js';
import { EbookLocator, ReaderDescriptor, parseLocator, parseReader, record } from '../types';
import { safeDocument, safeSvg } from './sanitize';
import { safeCss } from './cssPolicy';
import { ASSET_BUDGET, READER_POLICY, resourceReference } from './policy';

const host = document.getElementById('book')!;
const shadow = host.attachShadow({ mode: 'open' });
const viewport = document.getElementById('viewport')!;
const contents = document.getElementById('contents') as HTMLSelectElement;
const font = document.getElementById('font') as HTMLSelectElement;
const previous = document.getElementById('previous') as HTMLButtonElement;
const next = document.getElementById('next') as HTMLButtonElement;
const status = document.getElementById('reader-status')!;
let port: MessagePort;
let descriptor: ReaderDescriptor;
let instance = '';
let section = 0;
let requestId = 0;
let navigating = false;
let ready = false;
let disposed = false;
let documentGeneration = 0;
let assetBytes = 0;
let restoredAnchor: { resourceId: string; textOffset: number; scrollTop: number } | undefined;
const cfiDocument = document.implementation.createHTMLDocument('Reader section');
const blobs = new Map<string, string>();
const requests = new Map<number, { resolve(value: ArrayBuffer): void; reject(error: Error): void }>();
const send = (type: string, data: object = {}) => port.postMessage({ type, instance, ...data });
function fail(): void {
  shadow.replaceChildren(); ready = false;
  status.textContent = 'Cannot read safely here; download original.';
  send('error');
}
function resource(id: string): Promise<ArrayBuffer> {
  if (disposed || !descriptor.resources.some(resource => resource.resourceId === id)) return Promise.reject(new Error('Unavailable resource'));
  const idNumber = ++requestId;
  return new Promise((resolve, reject) => {
    requests.set(idNumber, { resolve, reject }); send('resource', { requestId: idNumber, resourceId: id });
  });
}
async function asset(reference: string): Promise<string> {
  const parsed = resourceReference(reference);
  const entry = descriptor.resources.find(entry => entry.resourceId === parsed?.id);
  if (!entry || !/^(image\/(png|jpeg|gif|webp|svg\+xml)|font\/(woff2?|ttf|otf)|application\/(font-woff|vnd.ms-opentype|x-font-ttf))$/.test(entry.mediaType)) return 'about:invalid';
  const known = blobs.get(entry.resourceId);
  if (known) return known;
  if (assetBytes + entry.size > ASSET_BUDGET) throw new Error('Section assets exceed reader bound');
  assetBytes += entry.size;
  const bytes = await resource(entry.resourceId);
  const value = entry.mediaType === 'image/svg+xml' ? safeSvg(new TextDecoder().decode(bytes)) : bytes;
  const url = URL.createObjectURL(new Blob([value], { type: entry.mediaType }));
  blobs.set(entry.resourceId, url); return url;
}
async function stylesheet(reference: string): Promise<string> {
  const parsed = resourceReference(reference);
  const entry = descriptor.resources.find(entry => entry.resourceId === parsed?.id);
  if (!entry || entry.mediaType !== 'text/css' || entry.size > 512 * 1024) return '';
  return safeCss(new TextDecoder().decode(await resource(entry.resourceId)), asset);
}
function nodes(): Text[] {
  const article = shadow.querySelector('article');
  if (!article) return [];
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  const result: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) if (node instanceof Text && !node.parentElement?.closest('style,script')) result.push(node);
  return result;
}
function location(): EbookLocator {
  const top = viewport.getBoundingClientRect().top;
  const resourceId = descriptor.spine[section];
  const fraction = viewport.scrollTop / Math.max(1, viewport.scrollHeight - viewport.clientHeight);
  if (restoredAnchor?.resourceId === resourceId && Math.abs(restoredAnchor.scrollTop - viewport.scrollTop) < 1) {
    return { kind: 'epub', resourceId, textOffset: restoredAnchor.textOffset, fraction, policyVersion: READER_POLICY };
  }
  restoredAnchor = undefined;
  let offset = 0;
  for (const node of nodes()) {
    const range = document.createRange(); range.selectNodeContents(node);
    if (range.getBoundingClientRect().bottom > top) {
      // Find a fully visible line; restoring a partly clipped line drifts on each reflow.
      let low = 0; let high = node.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        range.setStart(node, middle);
        range.setEnd(node, middle + 1);
        if (range.getBoundingClientRect().top >= top - 1) high = middle;
        else low = middle + 1;
      }
      offset += low;
      break;
    }
    offset += node.length;
  }
  return {
    kind: 'epub', resourceId, textOffset: offset, fraction, policyVersion: READER_POLICY,
  };
}
function report(save = false): void { if (ready && !navigating && !disposed) send('location', { locator: location(), save }); }
function restore(locator: EbookLocator): void {
  if (locator.kind !== 'epub') return;
  let remaining = locator.textOffset;
  const mirror = cfiDocument.createTreeWalker(cfiDocument.body, NodeFilter.SHOW_TEXT);
  for (const node of nodes()) {
    const mirrored = mirror.nextNode();
    if (remaining <= node.length) {
      // Foliate resolves only our sanitized mirror, not book-supplied CFIs or a nested frame.
      if (!mirrored) break;
      const anchor = cfiDocument.createRange(); anchor.setStart(mirrored, remaining); anchor.collapse(true);
      const restored = toRange(cfiDocument, parseCfi(fromRange(anchor)));
      const range = document.createRange();
      range.setStart(node, restored.startOffset); range.setEnd(node, Math.min(node.length, restored.startOffset + 1));
      viewport.scrollTop += range.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      // Preserve the exact logical anchor until scrolling, rather than round to a new line on every reflow.
      restoredAnchor = { resourceId: locator.resourceId, textOffset: locator.textOffset, scrollTop: viewport.scrollTop };
      return;
    }
    remaining -= node.length;
  }
  viewport.scrollTop = locator.fraction * Math.max(0, viewport.scrollHeight - viewport.clientHeight);
}
async function navigate(index: number, saved?: EbookLocator, fragment?: string): Promise<void> {
  if (navigating || disposed || index < 0 || index >= descriptor.spine.length) return;
  report(true); navigating = true; ready = false; status.textContent = 'Loading section...';
  previous.disabled = true; next.disabled = true; contents.disabled = true;
  const generation = ++documentGeneration;
  let phase = 'resource';
  try {
    for (const url of blobs.values()) URL.revokeObjectURL(url);
    restoredAnchor = undefined;
    blobs.clear(); assetBytes = 0; shadow.replaceChildren();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await resource(descriptor.spine[index]));
    phase = 'sanitization';
    const content = await safeDocument(text, asset, stylesheet);
    if (disposed || generation !== documentGeneration) return;
    const base = document.createElement('style');
    base.textContent = ':host{display:block;color:#222;background:#faf8f1;line-height:1.65;font-family:Georgia,serif}.book-content{max-width:48rem;margin:0 auto;padding:1rem 1.25rem;overflow-wrap:anywhere}img,svg{max-width:100%;height:auto}a{color:#614100}';
    shadow.append(base, content); section = index;
    phase = 'mirror';
    cfiDocument.body.replaceChildren(shadow.querySelector('article')!.cloneNode(true));
    for (const style of cfiDocument.querySelectorAll('style,script')) style.remove();
    await Promise.all([...shadow.querySelectorAll('img')].map(image => image.decode()));
    await document.fonts.ready;
    phase = 'position';
    viewport.scrollTop = 0;
    if (saved) restore(saved);
    else if (fragment) shadow.getElementById(fragment)?.scrollIntoView();
    const toc = descriptor.toc.findIndex(entry => entry.resourceId === descriptor.spine[index]);
    contents.value = String(Math.max(0, toc));
    status.textContent = `Section ${index + 1} of ${descriptor.spine.length}`;
    ready = true;
  } catch (error) {
    console.warn('EPUB section failed', { phase, category: error instanceof Error ? error.name : 'Error' });
    fail();
  }
  finally {
    navigating = false; previous.disabled = section === 0; next.disabled = section === descriptor.spine.length - 1; contents.disabled = false;
    report(true);
  }
}
window.addEventListener('message', function boot(event: MessageEvent) {
  if (event.source !== parent || event.data?.type !== 'epub-init' || event.ports.length !== 1 || port) return;
  try {
    descriptor = parseReader(event.data.descriptor);
    if (descriptor.state !== 'ready' || typeof event.data.instance !== 'string') return;
    instance = event.data.instance; port = event.ports[0];
    port.onmessage = message => {
      const raw = record(message.data);
      if (raw.instance !== instance) return;
      if (raw.type === 'resource-result' && typeof raw.requestId === 'number') {
        const pending = requests.get(raw.requestId);
        if (!pending) return;
        requests.delete(raw.requestId);
        if (raw.bytes instanceof ArrayBuffer) pending.resolve(raw.bytes);
        else pending.reject(new Error('Reader resource unavailable'));
      }
    };
    for (const [index, entry] of descriptor.toc.entries()) {
      const option = document.createElement('option'); option.value = String(index); option.textContent = entry.title; contents.append(option);
    }
    const saved = event.data.locator ? parseLocator(event.data.locator) : undefined;
    const initial = saved?.kind === 'epub' ? Math.max(0, descriptor.spine.indexOf(saved.resourceId)) : 0;
    void navigate(initial, saved?.kind === 'epub' ? saved : undefined);
  } catch { status.textContent = 'Reader could not be initialized.'; }
});
previous.onclick = () => { void navigate(section - 1); };
next.onclick = () => { void navigate(section + 1); };
contents.onchange = () => {
  const entry = descriptor.toc[Number(contents.value)];
  if (entry) void navigate(descriptor.spine.indexOf(entry.resourceId), undefined, entry.fragment);
};
font.onchange = () => {
  const saved = location(); host.style.fontSize = `${font.value}px`; restore(saved); report(true);
};
shadow.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest('a') : null;
  if (!target) return;
  event.preventDefault();
  const reference = resourceReference(target.getAttribute('data-book-target') ?? '');
  if (reference) void navigate(descriptor.spine.indexOf(reference.id), undefined, reference.fragment);
});
viewport.addEventListener('scroll', () => report());
document.addEventListener('visibilitychange', () => report(true));
window.addEventListener('pagehide', () => { report(true); disposed = true; for (const url of blobs.values()) URL.revokeObjectURL(url); port?.close(); });
parent.postMessage({ type: 'epub-shell-ready' }, '*');
