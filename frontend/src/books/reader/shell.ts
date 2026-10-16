import { fromRange, toRange, parse as parseCfi } from 'foliate-js/epubcfi.js';
import { EbookLocator, ReaderDescriptor, parseLocator, parseReader, record } from '../types';
import { safeDocument, safeSvg } from './sanitize';
import { safeCss } from './cssPolicy';
import { ASSET_BUDGET, READER_POLICY, resourceReference } from './policy';
import { DEFAULT_PRESENTATION, ReaderPresentation, touchNavigation } from './presentation';
import { applyReaderChrome, pageLabel, trackReaderChrome } from './readerOverlays';

const host = document.getElementById('book')!;
const shadow = host.attachShadow({ mode: 'open' });
const viewport = document.getElementById('viewport')!;
const contents = document.getElementById('contents') as HTMLSelectElement;
const font = document.getElementById('font') as HTMLSelectElement;
const previous = document.getElementById('previous') as HTMLButtonElement;
const next = document.getElementById('next') as HTMLButtonElement;
const status = document.getElementById('reader-status')!;
const chrome = document.querySelector('nav')!;
const chromeContainer = document.createElement('div');
chromeContainer.dataset.readerChrome = '';
document.body.insertBefore(chromeContainer, chrome);
chromeContainer.append(chrome, status);
document.body.style.position = 'relative';
type Section = { element: HTMLElement; root: ShadowRoot; mirror: Document; assets: Set<string>; removeLabel(): void };
let port: MessagePort;
let descriptor: ReaderDescriptor;
let instance = '';
let section = 0;
let requestId = 0;
let navigating = false;
let ready = false;
let disposed = false;
let generation = 0;
let active = 0;
let assetBytes = 0;
let queue = Promise.resolve();
let presentation = DEFAULT_PRESENTATION;
let logical: EbookLocator | undefined;
let geometry = { width: 0, height: 0, scrollHeight: 0, top: 0 };
let restoredAnchor: { resourceId: string; textOffset: number; scrollTop: number } | undefined;
let focusControls = false;
const sections = new Map<number, Section>();
const blobs = new Map<string, { url: string; size: number; users: number }>();
const requests = new Map<number, { id: string; resolve(value: ArrayBuffer): void; reject(error: Error): void; sent: boolean }>();
const send = (type: string, data: object = {}) => port.postMessage({ type, instance, ...data });
const measure = () => {
  geometry = { width: viewport.clientWidth, height: viewport.clientHeight, scrollHeight: viewport.scrollHeight, top: viewport.scrollTop };
};
function releaseAssets(ids: Set<string>): void {
  for (const id of ids) {
    const value = blobs.get(id);
    if (value && --value.users === 0) { URL.revokeObjectURL(value.url); assetBytes -= value.size; blobs.delete(id); }
  }
  ids.clear();
}
function remove(index: number): void {
  const value = sections.get(index);
  if (!value) return;
  value.removeLabel(); value.element.remove(); releaseAssets(value.assets); sections.delete(index);
}
function fail(): void {
  ready = false;
  status.style.display = ''; status.setAttribute('role', 'alert');
  status.textContent = 'Cannot read safely here; download original.';
  send('error');
}
function drain(): void {
  for (const [number, value] of requests) {
    if (active >= 2 || disposed) break;
    if (value.sent) continue;
    value.sent = true; active++;
    send('resource', { requestId: number, resourceId: value.id });
  }
}
function resource(id: string): Promise<ArrayBuffer> {
  if (disposed || !descriptor.resources.some(resource => resource.resourceId === id)) return Promise.reject(new Error('Unavailable resource'));
  if (requests.size >= 8) return Promise.reject(new Error('Reader resource queue exceeds bound'));
  return new Promise((resolve, reject) => {
    requests.set(++requestId, { id, resolve, reject, sent: false }); drain();
  });
}
async function asset(reference: string, used: Set<string>): Promise<string> {
  const parsed = resourceReference(reference);
  const entry = descriptor.resources.find(entry => entry.resourceId === parsed?.id);
  if (!entry || !/^(image\/(png|jpeg|gif|webp|svg\+xml)|font\/(woff2?|ttf|otf)|application\/(font-woff|vnd.ms-opentype|x-font-ttf))$/.test(entry.mediaType)) return 'about:invalid';
  const known = blobs.get(entry.resourceId);
  if (known) {
    if (!used.has(entry.resourceId)) { used.add(entry.resourceId); known.users++; }
    return known.url;
  }
  if (assetBytes + entry.size > ASSET_BUDGET) throw new Error('Active section assets exceed reader bound');
  assetBytes += entry.size;
  try {
    const bytes = await resource(entry.resourceId);
    if (disposed) throw new Error('Reader closed');
    const value = entry.mediaType === 'image/svg+xml' ? safeSvg(new TextDecoder().decode(bytes)) : bytes;
    const url = URL.createObjectURL(new Blob([value], { type: entry.mediaType }));
    blobs.set(entry.resourceId, { url, size: entry.size, users: 1 }); used.add(entry.resourceId);
    return url;
  } catch (error) { assetBytes -= entry.size; throw error; }
}
async function stylesheet(reference: string, used: Set<string>): Promise<string> {
  const parsed = resourceReference(reference);
  const entry = descriptor.resources.find(entry => entry.resourceId === parsed?.id);
  if (!entry || entry.mediaType !== 'text/css' || entry.size > 512 * 1024) return '';
  return safeCss(new TextDecoder().decode(await resource(entry.resourceId)), reference => asset(reference, used));
}
function nodes(index = section): Text[] {
  const article = sections.get(index)?.root.querySelector('article');
  if (!article) return [];
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  const result: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) if (node instanceof Text && !node.parentElement?.closest('style,script')) result.push(node);
  return result;
}
function location(): EbookLocator {
  if (logical && (geometry.width !== viewport.clientWidth || geometry.height !== viewport.clientHeight ||
      geometry.scrollHeight !== viewport.scrollHeight)) return logical;
  const top = viewport.getBoundingClientRect().top;
  const resourceId = descriptor.spine[section];
  const value = sections.get(section);
  const fraction = value ? Math.max(0, Math.min(1,
    (top - value.element.getBoundingClientRect().top) / Math.max(1, value.element.offsetHeight - viewport.clientHeight))) : 0;
  if (restoredAnchor?.resourceId === resourceId && Math.abs(restoredAnchor.scrollTop - viewport.scrollTop) < 1) {
    return { kind: 'epub', resourceId, textOffset: restoredAnchor.textOffset, fraction, policyVersion: READER_POLICY };
  }
  restoredAnchor = undefined;
  let offset = 0;
  for (const node of nodes()) {
    const range = document.createRange(); range.selectNodeContents(node);
    if (range.getBoundingClientRect().bottom > top) {
      let low = 0, high = node.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        range.setStart(node, middle); range.setEnd(node, middle + 1);
        if (range.getBoundingClientRect().top >= top - 1) high = middle; else low = middle + 1;
      }
      offset += low; break;
    }
    offset += node.length;
  }
  return { kind: 'epub', resourceId, textOffset: offset, fraction, policyVersion: READER_POLICY };
}
function report(save = false): void {
  if (ready && !navigating && !disposed) { logical = location(); send('location', { locator: logical, save }); }
}
function restore(locator: EbookLocator): void {
  if (locator.kind !== 'epub') return;
  const index = descriptor.spine.indexOf(locator.resourceId), value = sections.get(index);
  if (!value) return;
  section = index;
  let remaining = locator.textOffset;
  const mirror = value.mirror.createTreeWalker(value.mirror.body, NodeFilter.SHOW_TEXT);
  for (const node of nodes()) {
    const mirrored = mirror.nextNode();
    if (remaining <= node.length) {
      if (!mirrored) break;
      const anchor = value.mirror.createRange(); anchor.setStart(mirrored, remaining); anchor.collapse(true);
      const restored = toRange(value.mirror, parseCfi(fromRange(anchor)));
      const range = document.createRange();
      range.setStart(node, restored.startOffset); range.setEnd(node, Math.min(node.length, restored.startOffset + 1));
      viewport.scrollTop += range.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      restoredAnchor = { resourceId: locator.resourceId, textOffset: locator.textOffset, scrollTop: viewport.scrollTop };
      logical = locator; measure(); return;
    }
    remaining -= node.length;
  }
  viewport.scrollTop += value.element.getBoundingClientRect().top - viewport.getBoundingClientRect().top +
    locator.fraction * Math.max(0, value.element.offsetHeight - viewport.clientHeight);
  logical = locator; measure();
}
function showChrome(): void {
  applyReaderChrome(chromeContainer, presentation);
  previous.hidden = next.hidden = presentation.mode !== 'paged';
  if (focusControls && !presentation.chromeHidden) { focusControls = false; contents.focus(); }
}
function controls(): void {
  previous.disabled = section === 0 && viewport.scrollTop <= 1;
  const value = sections.get(section);
  next.disabled = section === descriptor.spine.length - 1 &&
    (!value || value.element.getBoundingClientRect().bottom <= viewport.getBoundingClientRect().bottom + 1);
  contents.disabled = false;
  contents.value = String(Math.max(0, descriptor.toc.findIndex(entry => entry.resourceId === descriptor.spine[section])));
  previous.textContent = 'Previous page'; next.textContent = 'Next page';
  showChrome();
  if (status.getAttribute('role') !== 'alert') {
    status.textContent = `Section ${section + 1} of ${descriptor.spine.length}`;
  }
  host.dataset.sections = String(sections.size);
  host.dataset.assetBytes = String(assetBytes); host.dataset.blobUrls = String(blobs.size);
}
function sectionTop(): number | undefined {
  const value = sections.get(section);
  return value ? value.element.getBoundingClientRect().top - viewport.getBoundingClientRect().top : undefined;
}
function arrange(saved?: EbookLocator, visualTop?: number): void {
  shadow.replaceChildren(...[...sections.entries()].sort(([a], [b]) => a - b).map(([, value]) => value.element));
  // Keep short trailing sections reachable without loading beyond the window.
  const trailing = shadow.lastElementChild;
  host.style.paddingBottom = presentation.mode === 'continuous' && trailing instanceof HTMLElement
    ? `${Math.max(0, Math.ceil(viewport.clientHeight - trailing.getBoundingClientRect().height) + 1)}px` : '0';
  measure();
  if (saved) restore(saved);
  if (visualTop !== undefined) {
    viewport.scrollTop += (sectionTop() ?? visualTop) - visualTop;
    if (restoredAnchor) restoredAnchor.scrollTop = viewport.scrollTop;
    measure();
  }
  controls();
}
function wanted(index: number): number[] {
  return (presentation.mode === 'continuous' ? [index - 1, index, index + 1] : [index])
    .filter(value => value >= 0 && value < descriptor.spine.length);
}
async function load(index: number, epoch: number): Promise<void> {
  if (sections.has(index) || disposed || epoch !== generation) return;
  const used = new Set<string>();
  let retained = false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await resource(descriptor.spine[index]));
    const content = await safeDocument(text, reference => asset(reference, used), reference => stylesheet(reference, used));
    if (disposed || epoch !== generation) return;
    const element = document.createElement('section'); element.dataset.section = String(index);
    const root = element.attachShadow({ mode: 'open' });
    const base = document.createElement('style');
    base.textContent = ':host{display:block;color:#222;background:#faf8f1;line-height:1.65;font-family:Georgia,serif}.book-content{max-width:48rem;margin:0 auto;padding:1rem 1.25rem;overflow-wrap:anywhere}img,svg{max-width:100%;height:auto}a{color:#614100}';
    root.append(base, content);
    const mirror = document.implementation.createHTMLDocument('Reader section');
    mirror.body.replaceChildren(root.querySelector('article')!.cloneNode(true));
    for (const style of mirror.querySelectorAll('style,script')) style.remove();
    await Promise.all([...root.querySelectorAll('img')].map(image => image.decode()));
    if (disposed || epoch !== generation) return;
    sections.set(index, { element, root, mirror, assets: used,
      removeLabel: pageLabel(element, viewport, `Section ${index + 1} of ${descriptor.spine.length}`) }); retained = true;
  } finally { if (!retained) releaseAssets(used); }
}
function neighbors(epoch: number): void {
  queue = queue.then(async () => {
    for (const index of [section + 1, section - 1]) {
      if (disposed || epoch !== generation || presentation.mode !== 'continuous') return;
      if (index < 0 || index >= descriptor.spine.length || sections.has(index)) continue;
      await load(index, epoch);
      if (disposed || epoch !== generation) return;
      const saved = location();
      arrange(saved, sectionTop());
    }
  }).catch(error => {
    if (!disposed && epoch === generation) { console.warn('EPUB neighboring section failed', { category: error instanceof Error ? error.name : 'Error' }); fail(); }
  });
}
function navigate(index: number, saved?: EbookLocator, fragment?: string, end = false): void {
  if (disposed || index < 0 || index >= descriptor.spine.length) return;
  report(true); navigating = true; ready = false;
  const epoch = ++generation;
  status.textContent = 'Loading section...';
  previous.disabled = true; next.disabled = true; contents.disabled = true;
  queue = queue.then(async () => {
    if (disposed || epoch !== generation) return;
    for (const number of sections.keys()) if (!wanted(index).includes(number)) remove(number);
    await load(index, epoch);
    if (disposed || epoch !== generation) return;
    // Presentation can change while the section request is in flight.
    for (const number of sections.keys()) if (!wanted(index).includes(number)) remove(number);
    section = index; restoredAnchor = undefined; logical = undefined;
    arrange();
    const value = sections.get(index)!;
    viewport.scrollTop += value.element.getBoundingClientRect().top - viewport.getBoundingClientRect().top +
      (end ? Math.max(0, value.element.offsetHeight - viewport.clientHeight) : 0);
    if (saved) restore(saved);
    else if (fragment) value.root.getElementById(fragment)?.scrollIntoView();
    await document.fonts.ready;
    if (disposed || epoch !== generation) return;
    measure(); ready = true; navigating = false; controls(); report(true); neighbors(epoch);
  }).catch(error => {
    if (!disposed && epoch === generation) {
      navigating = false; console.warn('EPUB section failed', { category: error instanceof Error ? error.name : 'Error' }); fail();
    }
  });
}
function reflow(nextPresentation?: ReaderPresentation): void {
  const layoutChanged = !nextPresentation || nextPresentation.mode !== presentation.mode || nextPresentation.overlay !== presentation.overlay;
  const saved = logical ?? (ready ? location() : undefined);
  if (nextPresentation) presentation = nextPresentation;
  showChrome();
  if (!layoutChanged || !ready || navigating) return;
  const epoch = ++generation;
  for (const number of sections.keys()) if (!wanted(section).includes(number)) remove(number);
  arrange(saved); report(); neighbors(epoch);
}
function turn(delta: -1 | 1): void {
  if (!ready || navigating) return;
  const value = sections.get(section)!;
  const bounds = value.element.getBoundingClientRect(), view = viewport.getBoundingClientRect();
  if (delta > 0 && bounds.bottom > view.bottom + 1) viewport.scrollTop += Math.min(viewport.clientHeight * 0.9, bounds.bottom - view.bottom);
  else if (delta < 0 && bounds.top < view.top - 1) viewport.scrollTop -= Math.min(viewport.clientHeight * 0.9, view.top - bounds.top);
  else navigate(section + delta, undefined, undefined, delta < 0);
}
window.addEventListener('message', function boot(event: MessageEvent) {
  if (event.source !== parent || event.data?.type !== 'epub-init' || event.ports.length !== 1 || port) return;
  try {
    descriptor = parseReader(event.data.descriptor);
    if (descriptor.state !== 'ready' || typeof event.data.instance !== 'string') return;
    instance = event.data.instance; port = event.ports[0];
    presentation = event.data.presentation ?? DEFAULT_PRESENTATION;
    showChrome();
    port.onmessage = message => {
      const raw = record(message.data);
      if (raw.instance !== instance) return;
      if (raw.type === 'resource-result' && typeof raw.requestId === 'number') {
        const pending = requests.get(raw.requestId);
        if (!pending) return;
        requests.delete(raw.requestId); active--;
        if (raw.bytes instanceof ArrayBuffer) pending.resolve(raw.bytes); else pending.reject(new Error('Reader resource unavailable'));
        drain();
      } else if (raw.type === 'presentation') reflow(raw.presentation as ReaderPresentation);
      else if (raw.type === 'cancel-gesture') viewport.dispatchEvent(new Event('reader-cancel-gesture'));
    };
    for (const [index, entry] of descriptor.toc.entries()) {
      const option = document.createElement('option'); option.value = String(index); option.textContent = entry.title; contents.append(option);
    }
    const saved = event.data.locator ? parseLocator(event.data.locator) : undefined;
    const initial = saved?.kind === 'epub' ? Math.max(0, descriptor.spine.indexOf(saved.resourceId)) : 0;
    navigate(initial, saved?.kind === 'epub' ? saved : undefined);
  } catch { status.textContent = 'Reader could not be initialized.'; }
});
previous.onclick = () => turn(-1); next.onclick = () => turn(1);
contents.onchange = () => {
  const entry = descriptor.toc[Number(contents.value)];
  if (entry) navigate(descriptor.spine.indexOf(entry.resourceId), undefined, entry.fragment);
};
font.onchange = () => {
  logical = location(); host.style.fontSize = `${font.value}px`; reflow(); report(true);
};
shadow.addEventListener('click', event => {
  const target = event.composedPath().find(value => value instanceof Element && value.localName === 'a');
  if (!(target instanceof Element)) return;
  event.preventDefault();
  const reference = resourceReference(target.getAttribute('data-book-target') ?? '');
  if (reference) navigate(descriptor.spine.indexOf(reference.id), undefined, reference.fragment);
});
viewport.addEventListener('scroll', () => {
  if (!ready || navigating || disposed) return;
  if (geometry.width !== viewport.clientWidth || geometry.height !== viewport.clientHeight || geometry.scrollHeight !== viewport.scrollHeight) {
    reflow(); return;
  }
  if (viewport.scrollTop === geometry.top) return;
  if (presentation.mode === 'continuous') {
    const top = viewport.getBoundingClientRect().top;
    const visible = [...sections.entries()].find(([, value]) => {
      const bounds = value.element.getBoundingClientRect(); return bounds.top <= top + 1 && bounds.bottom > top + 1;
    });
    if (visible && visible[0] !== section) {
      section = visible[0]; restoredAnchor = undefined; report();
      const saved = logical, top = sectionTop(); const epoch = ++generation;
      for (const number of sections.keys()) if (!wanted(section).includes(number)) remove(number);
      arrange(saved, top); neighbors(epoch);
    }
  }
  report(); controls(); measure();
});
viewport.addEventListener('keydown', event => {
  if (['ArrowRight', 'PageDown', 'ArrowLeft', 'PageUp'].includes(event.key)) {
    event.preventDefault(); turn(['ArrowRight', 'PageDown'].includes(event.key) ? 1 : -1);
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') send('escape');
  else if (event.key === 'Tab' && presentation.chromeHidden) {
    event.preventDefault(); focusControls = true; send('reveal-controls');
  }
});
const removeChrome = trackReaderChrome(chromeContainer, state => { if (port && !disposed) send('chrome-interaction', state); });
const removeTouch = touchNavigation(viewport, turn);
const observer = new ResizeObserver(() => {
  if (ready && !navigating && (geometry.width !== viewport.clientWidth || geometry.height !== viewport.clientHeight ||
      geometry.scrollHeight !== viewport.scrollHeight)) reflow();
});
observer.observe(viewport); observer.observe(host);
document.addEventListener('visibilitychange', () => report(true));
window.addEventListener('pagehide', () => {
  report(true); disposed = true; generation++; observer.disconnect(); removeTouch(); removeChrome();
  for (const number of sections.keys()) remove(number);
  for (const value of requests.values()) value.reject(new Error('Reader closed'));
  requests.clear(); port?.close();
});
showChrome();
parent.postMessage({ type: 'epub-shell-ready' }, '*');
