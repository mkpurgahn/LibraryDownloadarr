import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { booksApi, booksErrorMessage, aborted } from './api';
import { BookItem, EbookLocator, ReaderDescriptor } from './types';
import { ProgressClient, SaveState } from './progress';
import { mountEpubReader } from './reader/epubAdapter';

export const ReaderPage: React.FC = () => {
  const { itemId, fileId } = useParams<{ itemId: string; fileId: string }>();
  const revision = useAuthStore(state => state.sessionRevision);
  const [item, setItem] = useState<BookItem>();
  const [descriptor, setDescriptor] = useState<ReaderDescriptor>();
  const [client, setClient] = useState<ProgressClient>();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState<SaveState>('unsaved');
  const [retry, setRetry] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { heading.current?.focus(); }, [item?.itemId]);
  useEffect(() => {
    const controller = new AbortController();
    let progress: ProgressClient | undefined;
    let reader: ReaderDescriptor | undefined;
    let unsubscribe: (() => void) | undefined;
    setItem(undefined); setDescriptor(undefined); setClient(undefined); setStarted(false); setError('');
    void (async () => {
      if (!itemId || !fileId) throw new Error('Book original not found.');
      const item = await booksApi.item(itemId, controller.signal);
      setItem(item);
      const file = item.files.find(file => file.fileId === fileId && file.available);
      if (!file) throw new Error('Book original is unavailable.');
      if (file.extension !== 'epub') throw new Error('PDF reading is not enabled in this preview yet. Download the original from the book page.');
      reader = await booksApi.prepareReader({ itemId, fileId, contentVersion: file.contentVersion }, controller.signal);
      if (controller.signal.aborted) return;
      setDescriptor(reader);
      if (reader.state !== 'ready') return;
      progress = new ProgressClient(item, 'ebook', fileId, reader.contentVersion);
      unsubscribe = progress.subscribe(setState);
      const saved = await progress.load();
      if (controller.signal.aborted) return;
      setClient(progress);
      if (!saved && progress.compatible) {
        await progress.claim({ kind: 'epub', resourceId: reader.spine[0], textOffset: 0, fraction: 0, policyVersion: reader.policyVersion }, 0);
        if (!controller.signal.aborted) setStarted(true);
      }
    })().catch(error => { if (!aborted(error) && !controller.signal.aborted) setError(booksErrorMessage(error)); });
    return () => {
      controller.abort(); unsubscribe?.();
      const current = progress;
      const finish = () => {
        current?.dispose();
        if (reader) void booksApi.releaseReader(reader.readerId).catch(error => {
          if (!aborted(error)) console.warn('Books reader release deferred to session expiry.');
        });
      };
      if (current?.location) void current.save(current.location).finally(finish); else finish();
    };
  }, [itemId, fileId, revision, retry]);
  useEffect(() => {
    if (!frame.current || !descriptor || !client || !started) return;
    const current = frame.current;
    const failure = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'string') setError(event.detail);
    };
    current.addEventListener('reader-error', failure);
    const dispose = mountEpubReader(current, descriptor, client);
    return () => { dispose(); current.removeEventListener('reader-error', failure); };
  }, [descriptor, client, started]);
  const resume = async (saved: boolean, here = false) => {
    if (!client || !descriptor) return;
    setError('');
    try {
      await client.load();
      const locator: EbookLocator = here && client.location?.kind === 'epub' ? client.location :
        saved && client.compatible && client.current?.locator.kind === 'epub' ? client.current.locator :
        { kind: 'epub', resourceId: descriptor.spine[0], textOffset: 0, fraction: 0, policyVersion: descriptor.policyVersion };
      await client.claim(locator, client.revision);
      setStarted(false);
      window.requestAnimationFrame(() => setStarted(true));
    } catch (error) { if (!aborted(error)) setError(booksErrorMessage(error)); }
  };
  return <main className="flex h-[100dvh] flex-col bg-dark p-3" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))', paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
    <header className="flex flex-wrap items-center justify-between gap-3 pb-2">
      <Link tabIndex={0} className="inline-flex min-h-11 items-center text-primary-300" to={`/books/items/${itemId}`}>Back to book</Link>
      <h1 ref={heading} tabIndex={-1} className="min-w-0 text-lg font-semibold outline-none">{item?.title ?? 'Book reader'}</h1>
      {started && <p role="status" className="text-sm text-gray-300">{state === 'saved' ? 'Position saved' : state === 'conflict' ? 'Another device changed the saved position.' : 'Position not saved yet.'}</p>}
    </header>
    {error && <div role="alert" className="mb-3 rounded bg-red-500/10 p-3 text-red-200">{error}
      <button className="btn-secondary ml-3 min-h-11" onClick={() => setRetry(value => value + 1)}>Open reader again</button>
    </div>}
    {!descriptor && !error && <p role="status" className="p-6">Preparing book...</p>}
    {descriptor?.state === 'download-only' && <p role="status" className="p-6">{descriptor.reason}</p>}
    {client && descriptor && (!started || state === 'conflict') && <section aria-label="Saved position" className="mb-3 rounded bg-dark-100 p-4">
      <p className="mb-3 text-gray-300">{!client.compatible ? 'The original or reader policy changed. Your previous position is retained, but cannot be applied to this version.' :
        state === 'conflict' ? 'Choose the saved position, or explicitly continue writing from here.' : 'A private saved position is available.'}</p>
      <div className="flex flex-wrap gap-3">
        {client.compatible && client.current && <button className="btn-primary min-h-11" onClick={() => void resume(true)}>Resume saved position</button>}
        {state === 'conflict' && client.compatible && <button className="btn-secondary min-h-11" onClick={() => void resume(false, true)}>Continue here</button>}
        <button className="btn-secondary min-h-11" onClick={() => void resume(false)}>Start from beginning</button>
      </div>
    </section>}
    {started && <iframe ref={frame} title="EPUB reader" sandbox="allow-scripts" className="min-h-0 w-full flex-1 rounded-lg border-0" />}
  </main>;
};
