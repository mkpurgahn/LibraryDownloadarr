import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { booksApi, BooksApiError, aborted, booksErrorMessage, BOOKS_CHANGED_EVENT } from '../api';
import { BookTarget, ComicDescriptor, ComicLocator, ComicResource } from '../types';
import { ProgressClient } from '../progress';
import { SESSION_CHANGED_EVENT } from '../../stores/authStore';

type Fit = 'page' | 'width' | 'manual';
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export const ComicReader: React.FC<{
  descriptor: ComicDescriptor; target: BookTarget; progress: ProgressClient;
}> = ({ descriptor, target, progress }) => {
  const initial = progress.location?.kind === 'cbz' ? progress.location :
    { kind: 'cbz' as const, page: 1, offset: 0, horizontal: 0, policyVersion: descriptor.policyVersion };
  const [page, setPage] = useState(initial.page);
  const [jump, setJump] = useState(String(initial.page));
  const [fit, setFit] = useState<Fit>('page');
  const [zoom, setZoom] = useState(100);
  const [rtl, setRtl] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [resource, setResource] = useState<ComicResource>();
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>();
  const manifest = useRef(descriptor);
  const anchor = useRef<ComicLocator>(initial);
  const snapshot = useRef<{
    image: HTMLImageElement; top: number; left: number;
    width: number; height: number; scrollWidth: number; scrollHeight: number;
  }>();
  const queue = useRef<Promise<void>>(Promise.resolve());
  const active = useRef<AbortController>();
  const timer = useRef<number>();
  const blocked = useRef(false);
  const touch = useRef<{ x: number; y: number }>();
  const total = descriptor.spine.length;

  const save = () => {
    if (!blocked.current && image.current?.naturalWidth) {
      position();
      void progress.save(anchor.current);
    }
  };
  const position = () => {
    const element = viewport.current;
    const previous = snapshot.current;
    if (!element || !image.current?.naturalWidth || previous?.image !== image.current) return;
    // A changed layout can clamp offsets before either scroll or ResizeObserver fires.
    if (element.clientWidth !== previous.width || element.clientHeight !== previous.height ||
        element.scrollWidth !== previous.scrollWidth || element.scrollHeight !== previous.scrollHeight) return;
    const vertical = element.scrollHeight - element.clientHeight;
    const horizontal = element.scrollWidth - element.clientWidth;
    anchor.current = { ...anchor.current,
      offset: vertical > 0 && element.scrollTop !== previous.top ? clamp(element.scrollTop / vertical) : anchor.current.offset,
      horizontal: horizontal > 0 && element.scrollLeft !== previous.left ? clamp(element.scrollLeft / horizontal) : anchor.current.horizontal };
    snapshot.current = { ...previous, top: element.scrollTop, left: element.scrollLeft };
    progress.location = anchor.current;
  };

  useEffect(() => {
    const element = viewport.current!;
    const observer = new ResizeObserver(() => {
      position();
      setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const visibility = () => { if (document.visibilityState === 'hidden') save(); };
    const changed = () => {
      blocked.current = true;
      active.current?.abort();
      image.current?.removeAttribute('src'); image.current = undefined;
      slot.current?.replaceChildren(); setResource(undefined); setLoading(false);
      setError('Your Books session or configuration changed. Reopen Books to continue.');
    };
    const interval = window.setInterval(save, 10000);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', save);
    window.addEventListener(SESSION_CHANGED_EVENT, changed);
    window.addEventListener(BOOKS_CHANGED_EVENT, changed);
    return () => {
      window.clearInterval(interval); window.clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', save);
      window.removeEventListener(SESSION_CHANGED_EVENT, changed);
      window.removeEventListener(BOOKS_CHANGED_EVENT, changed);
      if (manifest.current.readerId !== descriptor.readerId) release(manifest.current.readerId);
    };
  }, [descriptor, progress]);

  function release(readerId: string) {
    void booksApi.releaseReader(readerId).catch(error => {
      if (!aborted(error) && !(error instanceof BooksApiError && [404, 410].includes(error.status))) {
        console.warn('Books comic reader release deferred to session expiry.');
      }
    });
  }

  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    let url: string | undefined;
    let decoded: HTMLImageElement | undefined;
    const clear = () => {
      decoded?.removeAttribute('src');
      if (image.current === decoded) { image.current = undefined; slot.current?.replaceChildren(); }
      if (url) { URL.revokeObjectURL(url); url = undefined; }
    };
    controller.signal.addEventListener('abort', clear, { once: true });
    setLoading(true); setResource(undefined); setError(''); setJump(String(page));
    queue.current = queue.current.then(async () => {
      if (controller.signal.aborted || blocked.current) return;
      try {
        const current = () => {
          const entry = manifest.current.resources.find(entry => entry.resourceId === manifest.current.spine[page - 1]);
          if (!entry) throw new Error('This CBZ page is unavailable. Reopen the original.');
          return entry;
        };
        let entry = current();
        let bytes: ArrayBuffer;
        try {
          bytes = await booksApi.readerResource(manifest.current.readerId, entry.resourceId, entry.size, controller.signal);
        } catch (error) {
          if (!(error instanceof BooksApiError) || ![404, 410].includes(error.status)) throw error;
          const renewed = await booksApi.prepareReader(target, controller.signal);
          if (controller.signal.aborted) { release(renewed.readerId); return; }
          if (renewed.policyVersion !== 'cbz-pages-v1' || renewed.state !== 'ready' ||
              renewed.contentVersion !== descriptor.contentVersion ||
              JSON.stringify(renewed.spine) !== JSON.stringify(descriptor.spine)) {
            release(renewed.readerId);
            throw new Error('The CBZ or reader policy changed. Open it again to choose a position.');
          }
          const previous = manifest.current.readerId;
          manifest.current = renewed;
          release(previous);
          entry = current();
          bytes = await booksApi.readerResource(renewed.readerId, entry.resourceId, entry.size, controller.signal);
        }
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(new Blob([bytes], { type: entry.mediaType }));
        decoded = new Image();
        decoded.alt = `Comic page ${page} of ${total}`;
        decoded.draggable = false;
        decoded.className = 'block max-w-none';
        decoded.src = url;
        await decoded.decode();
        if (controller.signal.aborted) return;
        if (decoded.naturalWidth !== entry.width || decoded.naturalHeight !== entry.height) {
          throw new Error('This CBZ page could not be decoded safely; download the original.');
        }
        image.current = decoded;
        slot.current!.replaceChildren(decoded);
        if (anchor.current.page !== page) anchor.current = {
          kind: 'cbz', page, offset: 0, horizontal: rtl ? 1 : 0, policyVersion: descriptor.policyVersion,
        };
        progress.location = anchor.current;
        setResource(entry);
        setLoading(false);
        void progress.save(anchor.current);
      } catch (error) {
        if (!aborted(error) && !controller.signal.aborted) {
          clear(); setLoading(false);
          setError(error instanceof BooksApiError ? booksErrorMessage(error) :
            'This CBZ page cannot be displayed safely. Reopen the reader or download the original.');
        }
      } finally { if (controller.signal.aborted) clear(); }
    });
    return () => { controller.abort(); clear(); };
  }, [page, descriptor, progress, target.itemId, target.fileId, target.contentVersion]);

  useLayoutEffect(() => {
    const element = viewport.current;
    const current = image.current;
    if (!element || !current || !resource || !viewportSize.width) return;
    position();
    const scale = fit === 'width' ? viewportSize.width / resource.width :
      fit === 'page' ? Math.min(viewportSize.width / resource.width, viewportSize.height / resource.height) : zoom / 100;
    current.style.width = `${Math.max(1, Math.floor(resource.width * scale))}px`;
    current.style.height = 'auto';
    element.scrollTop = anchor.current.offset * Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollLeft = anchor.current.horizontal * Math.max(0, element.scrollWidth - element.clientWidth);
    snapshot.current = {
      image: current, top: element.scrollTop, left: element.scrollLeft,
      width: element.clientWidth, height: element.clientHeight,
      scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
    };
  }, [resource, fit, zoom, viewportSize]);

  const go = (next: number) => {
    if (blocked.current || next < 1 || next > total || !Number.isSafeInteger(next)) return;
    position(); save(); setPage(next);
  };
  const key = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); go(page + ((event.key === 'ArrowLeft') === rtl ? 1 : -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); go(event.key === 'Home' ? 1 : total);
    }
  };

  return <section aria-label="CBZ reader" className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <button className="btn-secondary min-h-11" disabled={page === 1 || blocked.current} onClick={() => go(page - 1)}>Previous page</button>
        <button className="btn-secondary min-h-11" disabled={page === total || blocked.current} onClick={() => go(page + 1)}>Next page</button>
      </div>
      <form className="flex items-center gap-2 text-sm" onSubmit={event => {
        event.preventDefault();
        const next = Number(jump);
        if (!Number.isSafeInteger(next) || next < 1 || next > total) { setError(`Choose a page from 1 to ${total}.`); return; }
        go(next);
      }}>
        <label htmlFor="comic-page">Page</label>
        <input id="comic-page" aria-label="Page number" type="number" inputMode="numeric" min={1} max={total}
          className="input min-h-11 w-20" value={jump} onChange={event => setJump(event.target.value)} />
        <span>of {total}</span>
        <button type="submit" aria-label="Go to page" className="btn-secondary min-h-11">Go</button>
      </form>
    </div>
    <div className="flex flex-wrap items-end gap-2 text-sm">
      <label className="flex-1">Page fit
        <select className="input mt-1 min-h-11" style={{ colorScheme: 'dark' }} value={fit}
          onChange={event => { position(); setFit(event.target.value as Fit); }}>
          <option value="page">Fit page</option><option value="width">Fit width</option><option value="manual">Manual zoom</option>
        </select>
      </label>
      <label>Zoom
        <select className="input mt-1 min-h-11" style={{ colorScheme: 'dark' }} value={zoom}
          onChange={event => { position(); setFit('manual'); setZoom(Number(event.target.value)); }}>
          {[50, 75, 100, 125, 150, 200, 300].map(value => <option key={value} value={value}>{value}%</option>)}
        </select>
      </label>
      <button className="btn-secondary min-h-11" aria-label={`Reading direction: ${rtl ? 'right to left' : 'left to right'}`}
        onClick={() => setRtl(value => !value)}>{rtl ? 'Right to left' : 'Left to right'}</button>
    </div>
    <p className="text-xs text-gray-400">Arrow keys or swipe to turn pages. {rtl ? 'Left arrow goes forward.' : 'Right arrow goes forward.'} Scroll to explore a zoomed page.</p>
    {error && <p role="alert" className="rounded bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
    <div ref={viewport} role="region" aria-label="Comic page" aria-busy={loading} tabIndex={0}
      data-decoded-pixels={resource ? resource.width * resource.height : 0}
      className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-dark-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-300"
      onKeyDown={key}
      onScroll={() => { position(); window.clearTimeout(timer.current); timer.current = window.setTimeout(save, 400); }}
      onTouchStart={event => {
        touch.current = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : undefined;
      }}
      onTouchEnd={event => {
        const start = touch.current; touch.current = undefined;
        const end = event.changedTouches[0]; const element = viewport.current;
        if (!start || !end || !element || element.scrollWidth > element.clientWidth + 1) return;
        const dx = end.clientX - start.x; const dy = end.clientY - start.y;
        if (Math.abs(dx) > 60 && Math.abs(dy) < 40) go(page + ((dx > 0) === rtl ? 1 : -1));
      }}>
      {loading && <p role="status" className="p-4 text-sm text-gray-300">Loading page {page} of {total}...</p>}
      <div ref={slot} className="mx-auto w-fit" />
    </div>
    <p role="status" className="text-center text-sm tabular-nums text-gray-300">{loading ? 'Preparing page' : error ? 'Page unavailable' : `Page ${page} of ${total}`}</p>
  </section>;
};
