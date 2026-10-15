import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { booksApi, BooksApiError, aborted, booksErrorMessage, BOOKS_CHANGED_EVENT } from '../api';
import { BookTarget, ComicDescriptor, ComicLocator, ComicResource } from '../types';
import { ProgressClient } from '../progress';
import { SESSION_CHANGED_EVENT } from '../../stores/authStore';
import { ProgressiveComicSource } from './progressiveComic';

type Fit = 'page' | 'width' | 'manual';
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export const ComicReader: React.FC<{
  descriptor: ComicDescriptor; target: BookTarget; progress: ProgressClient;
  source?: ProgressiveComicSource; initialLocator?: ComicLocator; onRendered?: (locator: ComicLocator) => Promise<void>;
}> = ({ descriptor, target, progress, source, initialLocator, onRendered }) => {
  const initial = initialLocator ?? (progress.location?.kind === 'cbz' ? progress.location :
    { kind: 'cbz' as const, page: 1, offset: 0, horizontal: 0, policyVersion: descriptor.policyVersion });
  const [page, setPage] = useState(initial.page);
  const [jump, setJump] = useState(String(initial.page));
  const [fit, setFit] = useState<Fit>('page');
  const [zoom, setZoom] = useState(100);
  const [options, setOptions] = useState(false);
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
  const touch = useRef<{ id: number; x: number; y: number; image: HTMLImageElement; page: number }>();
  const touchCancelled = useRef(false);
  const pointer = useRef<{
    id: number; x: number; y: number; time: number; side: 'left' | 'right';
    image: HTMLImageElement; page: number; ready: boolean;
  }>();
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
    const start = (event: TouchEvent) => {
      if (event.touches.length === 1) touchCancelled.current = false;
      else cancelGesture();
    };
    const move = (event: TouchEvent) => {
      if (event.touches.length !== 1 ||
          (touch.current && event.touches[0].identifier !== touch.current.id)) cancelGesture();
    };
    const end = (event: TouchEvent) => { if (event.touches.length) cancelGesture(); };
    // A second contact can start on controls outside the viewport. Keep cancellation
    // latched through every release; only a new single-contact gesture resets it.
    document.addEventListener('touchstart', start, { capture: true, passive: true });
    document.addEventListener('touchmove', move, { capture: true, passive: true });
    document.addEventListener('touchend', end, { capture: true, passive: true });
    document.addEventListener('touchcancel', cancelGesture, { capture: true, passive: true });
    return () => {
      document.removeEventListener('touchstart', start, true);
      document.removeEventListener('touchmove', move, true);
      document.removeEventListener('touchend', end, true);
      document.removeEventListener('touchcancel', cancelGesture, true);
    };
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
        let entry = source ? await source.page(page, controller.signal) : current();
        let bytes: ArrayBuffer;
        try {
          bytes = await booksApi.readerResource(source?.readerId ?? manifest.current.readerId, entry.resourceId, entry.size, controller.signal);
        } catch (error) {
          if (!(error instanceof BooksApiError) || ![404, 410].includes(error.status)) throw error;
          if (source) {
            await source.renew(page, controller.signal);
            entry = await source.page(page, controller.signal);
            bytes = await booksApi.readerResource(source.readerId, entry.resourceId, entry.size, controller.signal);
          } else {
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
          kind: 'cbz', page, offset: 0, horizontal: 0, policyVersion: descriptor.policyVersion,
        };
        progress.location = anchor.current;
        setResource(entry);
        setLoading(false);
        if (onRendered) void onRendered(anchor.current); else void progress.save(anchor.current);
      } catch (error) {
        if (!aborted(error) && !controller.signal.aborted) {
          clear(); setLoading(false);
          setError(error instanceof BooksApiError ? booksErrorMessage(error) :
            'This CBZ page cannot be displayed safely. Reopen the reader or download the original.');
        }
      } finally { if (controller.signal.aborted) clear(); }
    });
    return () => { controller.abort(); clear(); };
  }, [page, descriptor, progress, source, onRendered, target.itemId, target.fileId, target.contentVersion]);

  // Restore disclosure reflows in this commit, before new user scrolls can reach ResizeObserver.
  useLayoutEffect(() => {
    const element = viewport.current;
    const current = image.current;
    if (!element || !current || !resource || !element.clientWidth) return;
    position();
    const scale = fit === 'width' ? element.clientWidth / resource.width :
      fit === 'page' ? Math.min(element.clientWidth / resource.width, element.clientHeight / resource.height) : zoom / 100;
    current.style.width = `${Math.max(1, Math.floor(resource.width * scale))}px`;
    current.style.height = 'auto';
    element.scrollTop = anchor.current.offset * Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollLeft = anchor.current.horizontal * Math.max(0, element.scrollWidth - element.clientWidth);
    snapshot.current = {
      image: current, top: element.scrollTop, left: element.scrollLeft,
      width: element.clientWidth, height: element.clientHeight,
      scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
    };
  }, [resource, fit, zoom, viewportSize, options]);

  const go = (next: number) => {
    if ((loading && !source) || blocked.current || next === page || next < 1 || next > total || !Number.isSafeInteger(next)) return;
    cancelGesture();
    position(); save(); setLoading(true); setPage(next);
  };
  const turn = (delta: -1 | 1) => go((page - 1 + delta + total) % total + 1);
  const key = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); turn(event.key === 'ArrowRight' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); go(event.key === 'Home' ? 1 : total);
    }
  };

  function cancelGesture() {
    touchCancelled.current = true; pointer.current = undefined; touch.current = undefined;
  }
  const hasSelection = () => window.getSelection()?.isCollapsed === false;
  const edgeAt = (x: number, y: number): 'left' | 'right' | undefined => {
    const current = image.current; const element = viewport.current;
    if (!current || !element) return;
    const pageBounds = current.getBoundingClientRect(); const viewBounds = element.getBoundingClientRect();
    const left = Math.max(pageBounds.left, viewBounds.left); const right = Math.min(pageBounds.right, viewBounds.right);
    const top = Math.max(pageBounds.top, viewBounds.top); const bottom = Math.min(pageBounds.bottom, viewBounds.bottom);
    if (x < left || x > right || y < top || y > bottom || right <= left) return;
    const fraction = (x - left) / (right - left);
    return fraction <= 0.25 ? 'left' : fraction >= 0.75 ? 'right' : undefined;
  };
  const pointerDown = (event: React.PointerEvent) => {
    pointer.current = undefined;
    if (loading || blocked.current || !event.isPrimary || event.button !== 0 ||
        event.target !== image.current || hasSelection()) return;
    const side = edgeAt(event.clientX, event.clientY);
    if (side && image.current) pointer.current = {
      id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp,
      side, image: image.current, page, ready: false,
    };
  };
  const pointerMove = (event: React.PointerEvent) => {
    const side = edgeAt(event.clientX, event.clientY);
    if (image.current) image.current.style.cursor = side && !loading && !blocked.current && total > 1 ? 'pointer' : 'default';
    const start = pointer.current;
    if (start && (event.pointerId !== start.id || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8)) {
      pointer.current = undefined;
    }
  };
  const pointerUp = (event: React.PointerEvent) => {
    pointerMove(event);
    const start = pointer.current;
    if (!start || event.timeStamp - start.time > 500 || hasSelection() ||
        edgeAt(event.clientX, event.clientY) !== start.side) { pointer.current = undefined; return; }
    start.ready = true;
  };
  const clickEdge = (event: React.MouseEvent) => {
    const start = pointer.current; pointer.current = undefined;
    if (!start?.ready || start.page !== page || start.image !== image.current || event.target !== image.current ||
        event.detail === 0 || hasSelection() || edgeAt(event.clientX, event.clientY) !== start.side) return;
    turn(start.side === 'right' ? 1 : -1);
  };
  const pageButton = (side: 'left' | 'right') => {
    const forward = side === 'right';
    const disabled = loading || blocked.current || total === 1;
    return <button type="button" aria-label={forward ? 'Next page' : 'Previous page'}
      title={forward ? 'Next page' : 'Previous page'} disabled={disabled}
      className="btn-primary flex h-11 w-11 shrink-0 items-center justify-center p-0 disabled:cursor-not-allowed disabled:opacity-40"
      onClick={() => turn(forward ? 1 : -1)}>
      <svg viewBox="0 0 24 24" aria-hidden="true" className={`h-5 w-5 fill-none stroke-current stroke-2 ${side === 'right' ? 'rotate-180' : ''}`}>
        <path d="m14 6-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>;
  };

  return <section aria-label="CBZ reader" className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
    <div role="group" aria-label="Page navigation" className="flex items-center gap-2">
      {pageButton('left')}
      <form className="flex min-w-0 flex-1 items-center justify-center gap-1 text-sm tabular-nums" onSubmit={event => {
        event.preventDefault();
        const next = Number(jump);
        if (!Number.isSafeInteger(next) || next < 1 || next > total) { setError(`Choose a page from 1 to ${total}.`); return; }
        go(next);
      }}>
        <label htmlFor="comic-page" className="sr-only">Page number</label>
        <input id="comic-page" aria-label="Page number" type="number" inputMode="numeric" min={1} max={total}
          disabled={(loading && !source) || blocked.current} className="input min-h-11 w-16 appearance-none px-2 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" value={jump}
          onChange={event => setJump(event.target.value)} />
        <span className="whitespace-nowrap text-gray-400">/ {total}</span>
        <button type="submit" aria-label="Go to page" disabled={(loading && !source) || blocked.current}
          className="min-h-11 min-w-11 rounded-lg px-2 text-gray-300 hover:bg-dark-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-300 disabled:opacity-40">Go</button>
      </form>
      {pageButton('right')}
      <button type="button" aria-label="View options" aria-expanded={options} aria-controls="comic-view-options"
        className="min-h-11 min-w-11 shrink-0 rounded-lg px-2 text-sm text-gray-300 hover:bg-dark-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-300"
        onClick={() => { position(); setOptions(value => !value); }}>View</button>
    </div>
    {options && <div id="comic-view-options" role="region" aria-label="Reading options" className="grid grid-cols-2 items-end gap-2 text-sm">
      <label className="min-w-0">Page fit
        <select className="input mt-1 min-h-11 px-2" style={{ colorScheme: 'dark' }} value={fit}
          onChange={event => { position(); setFit(event.target.value as Fit); }}>
          <option value="page">Fit page</option><option value="width">Fit width</option><option value="manual">Manual</option>
        </select>
      </label>
      <label className="min-w-0">Zoom
        <select className="input mt-1 min-h-11 px-2" style={{ colorScheme: 'dark' }} value={zoom}
          onChange={event => { position(); setFit('manual'); setZoom(Number(event.target.value)); }}>
          {[50, 75, 100, 125, 150, 200, 300].map(value => <option key={value} value={value}>{value}%</option>)}
        </select>
      </label>
    </div>}
    <p id="comic-navigation-help" className="text-xs text-gray-400">
      {total === 1 ? 'This original has one page.' : 'Left: previous. Right: next. First and last pages connect within this original.'}
    </p>
    {error && <p role="alert" className="rounded bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
    <div ref={viewport} role="region" aria-label="Comic page" aria-busy={loading} tabIndex={0}
      aria-describedby="comic-navigation-help"
      data-decoded-pixels={resource ? resource.width * resource.height : 0}
      className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-dark-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-300"
      onKeyDown={key}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
      // Native touch scrolling/swiping may cancel the pointer stream without cancelling the touch.
      onPointerCancel={() => { pointer.current = undefined; }} onClick={clickEdge}
      onContextMenu={cancelGesture} onWheel={cancelGesture}
      onScroll={() => { cancelGesture(); position(); window.clearTimeout(timer.current); timer.current = window.setTimeout(save, 400); }}
      onTouchStart={event => {
        if (touchCancelled.current || event.touches.length !== 1 || loading || blocked.current ||
            !image.current || hasSelection()) { cancelGesture(); return; }
        const contact = event.touches[0];
        touch.current = { id: contact.identifier, x: contact.clientX, y: contact.clientY, image: image.current, page };
      }}
      onTouchCancel={cancelGesture}
      onTouchEnd={event => {
        const start = touch.current; touch.current = undefined;
        const end = event.changedTouches[0]; const element = viewport.current;
        if (!start || touchCancelled.current || event.touches.length || event.changedTouches.length !== 1 ||
            !end || end.identifier !== start.id || !element || start.image !== image.current || start.page !== page) {
          pointer.current = undefined; return;
        }
        const dx = end.clientX - start.x; const dy = end.clientY - start.y;
        if (Math.hypot(dx, dy) > 8) pointer.current = undefined;
        if (element.scrollWidth > element.clientWidth + 1 || hasSelection()) return;
        if (Math.abs(dx) > 60 && Math.abs(dy) < 40) turn(dx < 0 ? 1 : -1);
      }}>
      {loading && <p role="status" className="p-4 text-sm text-gray-300">Loading page {page} of {total}...</p>}
      <div ref={slot} className="mx-auto w-fit" />
    </div>
    <p role="status" className="sr-only">{loading ? `Loading page ${page} of ${total}` : !resource && error ? 'Page unavailable' : `Page ${page} of ${total}`}</p>
  </section>;
};
