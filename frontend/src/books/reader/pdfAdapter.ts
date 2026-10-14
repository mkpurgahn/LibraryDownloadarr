import { AnnotationMode, PDFDataRangeTransport, PDFWorker, TextLayer, getDocument } from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import assetJson from '../../../.reader-build/pdf-assets.json?raw';
import { BooksApiError, booksApi, aborted, BOOKS_CHANGED_EVENT } from '../api';
import { BookTarget, EbookLocator, integer, list, record, text } from '../types';
import { ProgressClient } from '../progress';
import { SESSION_CHANGED_EVENT } from '../../stores/authStore';
import { PDF_LIMITS, PdfCacheBudget, PdfLimitError } from './pdfPolicy';

const activeReaders = new WeakMap<HTMLElement, () => void>();
const assetManifest = new Map(list(JSON.parse(assetJson)).map(value => {
  const raw = record(value);
  const name = text(raw.path, 200);
  if (!/^(cmaps|standard_fonts)\/[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Invalid PDF asset manifest');
  return [name, integer(raw.size)] as const;
}));
interface PageView {
  page: PDFPageProxy; element: HTMLElement; canvas: HTMLCanvasElement; text: TextLayer;
  releaseText: Array<() => void>; capped: boolean;
}
export interface PdfReader {
  setZoom(scale: number): void;
  goToPage(page: number, offset: number): Promise<void>;
  dispose(): void;
}

export async function mountPdfReader(
  container: HTMLElement, target: BookTarget, progress: ProgressClient, signal: AbortSignal
): Promise<PdfReader> {
  activeReaders.get(container)?.();
  const controller = new AbortController();
  let disposed = false;
  let worker: Worker | undefined;
  let loading: PDFDocumentLoadingTask | undefined;
  let documentProxy: PDFDocumentProxy | undefined;
  let generation = 0;
  let current = 1;
  let zoom = 1;
  let ready = false;
  let changing = false;
  let timer = 0;
  let navigation: Promise<void> = Promise.resolve();
  let scrollFrame = 0;
  let phase = 'headers';
  let restoredPosition: { page: number; scrollTop: number; offset: number } | undefined;
  const views = new Map<number, PageView>();
  const renders = new Set<RenderTask>();
  const textLayers = new Set<TextLayer>();
  const canvases = new Map<HTMLCanvasElement, number>();
  const assets = new Map<string, { data: Uint8Array; release(): void }>();
  const budget = new PdfCacheBudget((used, peak) => {
    if (activeReaders.get(container) !== dispose) return;
    container.dataset.pdfCachedBytes = String(used);
    container.dataset.pdfPeakCachedBytes = String(peak);
  });
  container.dataset.pdfCachedBytes = '0'; container.dataset.pdfPeakCachedBytes = '0';
  container.dataset.pdfSourceBackingBytes = '0'; container.dataset.pdfEngineOverhead = 'not-measured';
  container.dataset.pdfWorkerActive = 'false';
  const shadow = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{display:flex;flex-direction:column;min-height:0;height:100%;background:#292929;color:#222;border-radius:8px;overflow:hidden;font:16px system-ui}
    *{box-sizing:border-box}nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px;background:#f1eee5}button,input,select{font:inherit;min-height:44px;border:1px solid #777;border-radius:5px;color:#222;background:#fff;padding:6px}input{width:5rem}label{display:flex;gap:6px;align-items:center}button:disabled{opacity:.45}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #8d5900}.status{padding:6px 10px;color:#eee;font-size:12px}.viewport{position:relative;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding-bottom:70vh}.page{position:relative;background:#fff;margin:12px auto}canvas{display:block}.textLayer{position:absolute;inset:0;overflow:clip;line-height:1;text-align:initial;transform-origin:0 0;text-size-adjust:none;forced-color-adjust:none;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size))}.textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0}.textLayer > :not(.markedContent),.textLayer .markedContent span:not(.markedContent){font-size:calc(var(--text-scale-factor) * var(--font-height,0));transform:rotate(var(--rotate,0deg)) scaleX(var(--scale-x,1)) scale(var(--min-font-size-inv))}.textLayer .markedContent{display:contents}.textLayer ::selection{background:#b8d4f5}
    </style><nav aria-label="PDF controls"><button id="prev">Previous page</button><label>Page number<input id="page" type="number" min="1" value="1"></label><span id="total"></span><button id="next">Next page</button><label>Zoom<select id="zoom"><option value="0.75">75%</option><option value="1" selected>100%</option><option value="1.5">150%</option><option value="2">200%</option><option value="3">300%</option></select></label></nav><div class="status" role="status">Loading PDF...</div><div class="viewport" role="region" aria-label="PDF pages" tabindex="0"></div>`;
  const viewport = shadow.querySelector<HTMLElement>('.viewport')!;
  const status = shadow.querySelector<HTMLElement>('.status')!;
  const pageInput = shadow.querySelector<HTMLInputElement>('#page')!;
  const previous = shadow.querySelector<HTMLButtonElement>('#prev')!;
  const next = shadow.querySelector<HTMLButtonElement>('#next')!;
  const zoomSelect = shadow.querySelector<HTMLSelectElement>('#zoom')!;
  const raise = (error: unknown) => {
    if (!disposed && !aborted(error)) {
      console.warn('PDF reader failed', { phase, category: error instanceof Error ? error.name : 'Error' });
      const message = error instanceof PdfLimitError || error instanceof BooksApiError ? error.message :
        'Cannot read this PDF safely here; download the original.';
      container.dispatchEvent(new CustomEvent('reader-error', { detail: message }));
      dispose();
    }
  };
  function canvasSize(canvas: HTMLCanvasElement, width: number, height: number): void {
    width = Math.ceil(width); height = Math.ceil(height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        width * height > PDF_LIMITS.pagePixels) throw new PdfLimitError('PDF pixel limit reached; reduce zoom or download the original.');
    const bytes = width * height * 4;
    budget.adjust(bytes - (canvases.get(canvas) ?? 0)); canvases.set(canvas, bytes);
    canvas.width = width; canvas.height = height;
    container.dataset.pdfMaxCanvasPixels = String(Math.max(Number(container.dataset.pdfMaxCanvasPixels ?? 0), width * height));
  }
  function destroyCanvas(canvas: HTMLCanvasElement): void {
    const bytes = canvases.get(canvas);
    if (bytes !== undefined) { canvas.width = 0; canvas.height = 0; canvases.delete(canvas); budget.adjust(-bytes); }
  }
  function removePage(number: number): void {
    const view = views.get(number);
    if (!view) return;
    view.text.cancel(); view.releaseText.forEach(release => release());
    destroyCanvas(view.canvas); view.element.remove(); view.page.cleanup(); views.delete(number);
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true; ready = false; generation += 1;
    restoredPosition = undefined; current = 1;
    controller.abort(); clearInterval(timer); cancelAnimationFrame(scrollFrame);
    for (const render of renders) render.cancel();
    for (const layer of textLayers) layer.cancel();
    worker?.terminate();
    container.dataset.pdfWorkerActive = 'false'; container.dataset.pdfSourceBackingBytes = '0';
    for (const number of [...views.keys()]) removePage(number);
    for (const canvas of [...canvases.keys()]) destroyCanvas(canvas);
    for (const asset of assets.values()) asset.release();
    assets.clear(); shadow.replaceChildren();
    container.dataset.pdfCachedBytes = '0';
    if (loading) void loading.destroy().catch(() => console.warn('PDF document cleanup could not finish after worker termination.'));
    signal.removeEventListener('abort', dispose);
    window.removeEventListener(SESSION_CHANGED_EVENT, dispose);
    window.removeEventListener(BOOKS_CHANGED_EVENT, changed);
    document.removeEventListener('visibilitychange', saveOnHidden);
    window.removeEventListener('pagehide', save);
    if (activeReaders.get(container) === dispose) activeReaders.delete(container);
  }
  activeReaders.set(container, dispose);
  const changed = () => {
    container.dispatchEvent(new CustomEvent('reader-error', { detail: 'Books configuration changed. Reopen Books to continue.' }));
    dispose();
  };
  signal.addEventListener('abort', dispose, { once: true });
  window.addEventListener(SESSION_CHANGED_EVENT, dispose);
  window.addEventListener(BOOKS_CHANGED_EVENT, changed);
  if (signal.aborted) dispose();
  const check = () => { if (disposed) throw new DOMException('PDF reader closed', 'AbortError'); };
  function cancellable<T>(promise: Promise<T>): Promise<T> {
    check();
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException('PDF reader closed', 'AbortError'));
      controller.signal.addEventListener('abort', abort, { once: true });
      promise.then(value => {
        controller.signal.removeEventListener('abort', abort); resolve(value);
      }, error => {
        controller.signal.removeEventListener('abort', abort); reject(error);
      });
    });
  }
  async function asset(name: string): Promise<Uint8Array> {
    check();
    const known = assets.get(name); if (known) return known.data.slice();
    const size = assetManifest.get(name);
    if (size === undefined) throw new PdfLimitError('PDF requires an unsupported font resource; download the original.');
    const release = budget.reserve(size);
    try {
      const response = await fetch(`/books-pdf/${name}`, { signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error('PDF static resource unavailable');
      const data = new Uint8Array(await response.arrayBuffer());
      check();
      if (data.byteLength !== size) throw new Error('PDF static resource changed');
      const raced = assets.get(name);
      if (raced) { release(); return raced.data.slice(); }
      assets.set(name, { data, release }); return data.slice();
    } catch (error) { release(); throw error; }
  }
  class CanvasFactory {
    create(width: number, height: number) {
      const canvas = document.createElement('canvas'); canvasSize(canvas, width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new PdfLimitError('Canvas rendering is unavailable; download the original.');
      return { canvas, context };
    }
    reset(target: { canvas: HTMLCanvasElement }, width: number, height: number) { canvasSize(target.canvas, width, height); }
    destroy(target: { canvas: HTMLCanvasElement }) { destroyCanvas(target.canvas); }
  }
  class CMapFactory {
    async fetch({ name }: { name: string }) { return { cMapData: await asset(`cmaps/${name}.bcmap`), compressionType: 1 }; }
  }
  class FontFactory {
    async fetch({ filename }: { filename: string }) { return asset(`standard_fonts/${filename}`); }
  }
  function location(): EbookLocator {
    if (restoredPosition?.page === current && Math.abs(viewport.scrollTop - restoredPosition.scrollTop) <= 1) {
      return { kind: 'pdf', page: current, offset: restoredPosition.offset };
    }
    restoredPosition = undefined;
    const view = views.get(current);
    const offset = view ? Math.max(0, Math.min(1, (viewport.scrollTop - view.element.offsetTop) / view.element.offsetHeight)) : 0;
    return { kind: 'pdf', page: current, offset: Math.round(offset * 1000) / 1000 };
  }
  function save(): void { if (ready && !disposed && !changing) { progress.location = location(); void progress.save(progress.location); } }
  function saveOnHidden(): void { if (document.visibilityState === 'hidden') save(); }
  try {
    const info = await booksApi.contentInfo(target, controller.signal); check();
    if (!info.size || info.size > PDF_LIMITS.documentBytes) throw new PdfLimitError('PDF exceeds the 512 MiB document limit; download the original.');
    if (info.mime !== 'application/pdf' || !info.ranges || !info.validator) throw new PdfLimitError('This original does not support safe PDF ranges; download it instead.');
    const waiting: Array<{ begin: number; end: number }> = [];
    let active = 0;
    const drain = () => {
      while (!disposed && active < 1 && waiting.length) {
        const range = waiting.shift()!;
        let release: () => void;
        try { release = budget.reserve(range.end - range.begin); } catch (error) { raise(error); return; }
        active += 1;
        void booksApi.contentRange(target, info, range.begin, range.end, controller.signal).then(data => {
          if (!disposed) transport.onDataRange(range.begin, new Uint8Array(data));
        }).catch(raise).finally(() => { active -= 1; release(); drain(); });
      }
    };
    class RangeTransport extends PDFDataRangeTransport {
      override requestDataRange(begin: number, end: number): void {
        if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > info.size ||
            waiting.length >= 32 || end - begin > PDF_LIMITS.cacheBytes) {
          raise(new PdfLimitError('PDF range request exceeds reader limits; download the original.')); return;
        }
        waiting.push({ begin, end }); drain();
      }
      override abort(): void { controller.abort(); waiting.length = 0; }
    }
    const transport = new RangeTransport(info.size, new Uint8Array(0), false);
    phase = 'document';
    worker = new Worker(workerUrl, { type: 'module' });
    const failedWorker = () => raise(new PdfLimitError('PDF worker is unavailable on this browser; download the original.'));
    worker.addEventListener('error', failedWorker);
    worker.addEventListener('messageerror', failedWorker);
    // PDF.js source backing is separate from our retained cache. Neither counter measures total resident memory.
    container.dataset.pdfWorkerActive = 'true'; container.dataset.pdfSourceBackingBytes = String(info.size);
    loading = getDocument({
      range: transport, worker: PDFWorker.create({ port: worker }), rangeChunkSize: 65536,
      disableStream: true, disableAutoFetch: true, isEvalSupported: false, enableXfa: false,
      useWorkerFetch: false, useWasm: false, useSystemFonts: false, disableFontFace: true,
      isOffscreenCanvasSupported: false, isImageDecoderSupported: false, stopAtErrors: true,
      CanvasFactory, CMapReaderFactory: CMapFactory, StandardFontDataFactory: FontFactory, verbosity: 0,
    });
    documentProxy = await cancellable(loading.promise); check();
    if (documentProxy.numPages < 1 || documentProxy.numPages > PDF_LIMITS.pages) throw new PdfLimitError('PDF exceeds the 5,000-page limit; download the original.');
    pageInput.max = String(documentProxy.numPages);
    shadow.querySelector('#total')!.textContent = `of ${documentProxy.numPages}`;

    async function renderPage(number: number, epoch: number): Promise<void> {
      if (views.has(number)) return;
      const page = await documentProxy!.getPage(number); check();
      if (epoch !== generation) return;
      const native = page.getViewport({ scale: 1 });
      if (!Number.isFinite(native.width * native.height) || native.width <= 0 || native.height <= 0) throw new PdfLimitError('PDF page dimensions are invalid.');
      const fit = Math.max(0.1, (viewport.clientWidth - 24) / native.width);
      const ratio = Math.max(1, Math.min(2, window.devicePixelRatio));
      const requested = fit * zoom;
      const maxPixels = Math.min(PDF_LIMITS.pagePixels, Math.floor(PDF_LIMITS.cacheBytes / 4 / 4));
      const scale = Math.min(requested, Math.sqrt(maxPixels / (native.width * native.height)) / ratio);
      const view = page.getViewport({ scale });
      const element = document.createElement('section'); element.className = 'page'; element.dataset.page = String(number);
      element.style.width = `${view.width}px`; element.style.height = `${view.height}px`;
      element.style.setProperty('--total-scale-factor', String(scale));
      const canvas = document.createElement('canvas');
      canvasSize(canvas, Math.max(1, Math.floor(view.width * ratio)), Math.max(1, Math.floor(view.height * ratio)));
      canvas.style.width = `${view.width}px`; canvas.style.height = `${view.height}px`;
      canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `PDF page ${number}`);
      const textContainer = document.createElement('div'); textContainer.className = 'textLayer';
      element.append(canvas, textContainer);
      const releases: Array<() => void> = [];
      let characters = 0; let items = 0;
      const boundedText = page.streamTextContent().pipeThrough(new TransformStream<TextContent, TextContent>({
        transform(chunk, output) {
          check();
          const size = chunk.items.reduce((sum, item) => sum + ('str' in item ? item.str.length * 2 : 0) + 128, 0);
          characters += chunk.items.reduce((sum, item) => sum + ('str' in item ? item.str.length : 0), 0);
          items += chunk.items.length;
          if (characters > 1024 * 1024 || items > 100000) throw new PdfLimitError('PDF text layer exceeds reader limits; download the original.');
          releases.push(budget.reserve(size)); output.enqueue(chunk);
        },
      }), { signal: controller.signal });
      const textLayer = new TextLayer({ textContentSource: boundedText, container: textContainer, viewport: view });
      textLayers.add(textLayer);
      const rendering = page.render({ canvas, viewport: view, transform: [ratio, 0, 0, ratio, 0, 0], annotationMode: AnnotationMode.DISABLE });
      renders.add(rendering);
      try {
        await Promise.all([rendering.promise, textLayer.render()]); check();
        if (epoch !== generation) throw new DOMException('PDF page replaced', 'AbortError');
        views.set(number, { page, element, canvas, text: textLayer, releaseText: releases, capped: scale < requested });
      } catch (error) {
        textLayer.cancel(); releases.forEach(release => release()); destroyCanvas(canvas); page.cleanup(); throw error;
      } finally { renders.delete(rendering); textLayers.delete(textLayer); }
    }
    const goToPage = (number: number, offset: number): Promise<void> => {
      check();
      if (!Number.isSafeInteger(number) || number < 1 || number > documentProxy!.numPages ||
          !Number.isFinite(offset) || offset < 0 || offset > 1) return Promise.reject(new PdfLimitError('Saved PDF position is outside this document; start from the beginning.'));
      save(); changing = true;
      const epoch = ++generation;
      for (const task of renders) task.cancel();
      for (const layer of textLayers) layer.cancel();
      const task = navigation.catch(() => {}).then(async () => {
        if (disposed || epoch !== generation) return;
        status.textContent = 'Rendering pages...';
        const wanted = [number - 1, number, number + 1].filter(page => page >= 1 && page <= documentProxy!.numPages);
        for (const page of [...views.keys()]) if (!wanted.includes(page)) removePage(page);
        for (const page of wanted) { await renderPage(page, epoch); if (disposed || epoch !== generation) return; }
        viewport.replaceChildren(...wanted.map(page => views.get(page)!.element));
        current = number; pageInput.value = String(number);
        previous.disabled = number === 1; next.disabled = number === documentProxy!.numPages;
        viewport.scrollTop = views.get(number)!.element.offsetTop + views.get(number)!.element.offsetHeight * offset;
        // Preserve the logical locator; browser pixel quantization must not rewrite it on every reopen.
        restoredPosition = { page: number, scrollTop: viewport.scrollTop, offset };
        container.dataset.pdfRenderedPages = String(views.size);
        container.dataset.pdfPagePixels = String(views.get(number)!.canvas.width * views.get(number)!.canvas.height);
        status.textContent = `Page ${number} of ${documentProxy!.numPages}${wanted.some(page => views.get(page)?.capped) ? ' / Zoom limited by the pixel/cache safety budget.' : ''}`;
        ready = true; changing = false; save();
      });
      navigation = task; return task;
    };
    const navigate = (page: number, offset = 0) => { void goToPage(page, offset).catch(error => { if (!aborted(error) && !disposed) raise(error); }); };
    const setZoom = (scale: number) => {
      if (!Number.isFinite(scale) || scale < 0.25 || scale > 3) throw new PdfLimitError('Unsupported PDF zoom.');
      const position = location(); save(); zoom = scale;
      changing = true;
      for (const task of renders) task.cancel();
      for (const page of [...views.keys()]) removePage(page);
      navigate(position.kind === 'pdf' ? position.page : current, position.kind === 'pdf' ? position.offset : 0);
    };
    previous.onclick = () => navigate(current - 1);
    next.onclick = () => navigate(current + 1);
    const jump = () => {
      const value = Number(pageInput.value);
      if (!Number.isSafeInteger(value) || value < 1 || value > documentProxy!.numPages) {
        status.textContent = `Enter a page from 1 to ${documentProxy!.numPages}.`;
        pageInput.value = String(current); return;
      }
      navigate(value);
    };
    pageInput.onchange = jump;
    pageInput.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); jump(); } };
    zoomSelect.onchange = () => setZoom(Number(zoomSelect.value));
    viewport.onkeydown = event => {
      if (event.key === 'PageDown' && current < documentProxy!.numPages) { event.preventDefault(); navigate(current + 1); }
      else if (event.key === 'PageUp' && current > 1) { event.preventDefault(); navigate(current - 1); }
    };
    viewport.onscroll = () => {
      if (!ready || changing || disposed) return;
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => {
        if (!ready || changing || disposed) return;
        const visible = [...views.entries()].find(([, view]) =>
          view.element.offsetTop <= viewport.scrollTop + 1 &&
          view.element.offsetTop + view.element.offsetHeight > viewport.scrollTop + 1);
        if (visible && visible[0] !== current) {
          const offset = Math.max(0, Math.min(1, (viewport.scrollTop - visible[1].element.offsetTop) / visible[1].element.offsetHeight));
          navigate(visible[0], offset);
        } else progress.location = location();
      });
    };
    const initial = progress.location?.kind === 'pdf' ? progress.location : { page: 1, offset: 0 };
    phase = 'pages';
    await goToPage(initial.page, initial.offset);
    document.addEventListener('visibilitychange', saveOnHidden);
    window.addEventListener('pagehide', save);
    timer = window.setInterval(() => { if (document.visibilityState === 'visible') save(); }, 10000);
    return { setZoom, goToPage, dispose };
  } catch (error) {
    if (!aborted(error)) console.warn('PDF reader failed', { phase, category: error instanceof Error ? error.name : 'Error' });
    dispose();
    if (aborted(error) || error instanceof PdfLimitError || error instanceof BooksApiError) throw error;
    throw new PdfLimitError('Cannot read this PDF safely here; download the original.');
  }
}
