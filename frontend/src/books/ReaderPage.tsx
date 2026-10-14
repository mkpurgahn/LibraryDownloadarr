import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { booksApi, booksErrorMessage, aborted } from './api';
import { BookFile, BookItem, EbookLocator, ReaderDescriptor, READ_LIMITS } from './types';
import { ProgressClient, SaveState } from './progress';
import { mountEpubReader } from './reader/epubAdapter';

export const ReaderPage: React.FC = () => {
  const { itemId, fileId } = useParams<{ itemId: string; fileId: string }>();
  const revision = useAuthStore(state => state.sessionRevision);
  const [item, setItem] = useState<BookItem>();
  const [file, setFile] = useState<BookFile>();
  const [descriptor, setDescriptor] = useState<ReaderDescriptor>();
  const [client, setClient] = useState<ProgressClient>();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState<SaveState>('unsaved');
  const [retry, setRetry] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const pdfContainer = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { heading.current?.focus(); }, [item?.itemId]);
  useEffect(() => {
    const controller = new AbortController();
    let progress: ProgressClient | undefined;
    let reader: ReaderDescriptor | undefined;
    let unsubscribe: (() => void) | undefined;
    setItem(undefined); setFile(undefined); setDescriptor(undefined); setClient(undefined); setStarted(false); setError('');
    void (async () => {
      if (!itemId || !fileId) throw new Error('Book original not found.');
      const item = await booksApi.item(itemId, controller.signal);
      setItem(item);
      const file = item.files.find(file => file.fileId === fileId && file.available);
      if (!file) throw new Error('Book original is unavailable.');
      if (!['epub', 'pdf'].includes(file.extension)) throw new Error('This original is download-only.');
      if (file.extension === 'pdf' && file.size > READ_LIMITS.pdf) throw new Error('PDF exceeds the 512 MiB document limit; download the original.');
      setFile(file);
      if (file.extension === 'epub') {
        reader = await booksApi.prepareReader({ itemId, fileId, contentVersion: file.contentVersion }, controller.signal);
        if (controller.signal.aborted) return;
        setDescriptor(reader);
        if (reader.state !== 'ready') return;
      }
      progress = new ProgressClient(item, 'ebook', fileId, reader?.contentVersion ?? file.contentVersion);
      unsubscribe = progress.subscribe(setState);
      const saved = await progress.load();
      if (controller.signal.aborted) return;
      if (!saved && progress.compatible) {
        try {
          await progress.claim(reader
            ? { kind: 'epub', resourceId: reader.spine[0], textOffset: 0, fraction: 0, policyVersion: reader.policyVersion }
            : { kind: 'pdf', page: 1, offset: 0 }, 0);
        } catch (error) {
          if (!controller.signal.aborted && (progress.current || !progress.compatible)) setClient(progress);
          throw error;
        }
        if (!controller.signal.aborted) setStarted(true);
      }
      if (!controller.signal.aborted) setClient(progress);
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
  useEffect(() => {
    if (!pdfContainer.current || !file || file.extension !== 'pdf' || !client || !started || !itemId) return;
    const current = pdfContainer.current;
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    const failure = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'string') setError(event.detail);
    };
    current.addEventListener('reader-error', failure);
    void import('./reader/pdfAdapter').then(module =>
      module.mountPdfReader(current, { itemId, fileId: file.fileId, contentVersion: file.contentVersion }, client, controller.signal)
    ).then(reader => {
      if (controller.signal.aborted) reader.dispose(); else dispose = reader.dispose;
    }).catch(error => { if (!aborted(error) && !controller.signal.aborted) setError(booksErrorMessage(error)); });
    return () => { controller.abort(); dispose?.(); current.removeEventListener('reader-error', failure); };
  }, [file, client, started, itemId]);
  const resume = async (saved: boolean, here = false) => {
    if (!client || !file) return;
    setError('');
    try {
      await client.load();
      const kind = file.extension === 'pdf' ? 'pdf' : 'epub';
      const local = here && client.location?.kind === kind ? client.location : undefined;
      const previous = saved && client.compatible && client.current?.locator.kind === kind ? client.current.locator : undefined;
      const locator: EbookLocator = local ?? previous ?? (
        descriptor ? { kind: 'epub', resourceId: descriptor.spine[0], textOffset: 0, fraction: 0, policyVersion: descriptor.policyVersion } :
          { kind: 'pdf', page: 1, offset: 0 });
      await client.claim(locator, client.revision);
      setStarted(false);
      window.requestAnimationFrame(() => setStarted(true));
    } catch (error) { if (!aborted(error)) setError(booksErrorMessage(error)); }
  };
  return <main className="flex flex-col bg-dark p-3" style={{ height: 'calc(100dvh - var(--books-player-height, 0px))', paddingTop: 'max(0.75rem, env(safe-area-inset-top))', paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
    <header className="flex flex-wrap items-center justify-between gap-3 pb-2">
      <Link tabIndex={0} className="inline-flex min-h-11 items-center text-primary-300" to={`/books/items/${itemId}`}>Back to book</Link>
      <h1 ref={heading} tabIndex={-1} className="min-w-0 text-lg font-semibold outline-none">{item?.title ?? 'Book reader'}</h1>
      {started && <p role="status" className="text-sm text-gray-300">{state === 'saved' ? 'Position saved' : state === 'conflict' ? 'Another device changed the saved position.' : 'Position not saved yet.'}</p>}
    </header>
    {error && <div role="alert" className="mb-3 rounded bg-red-500/10 p-3 text-red-200">{error}
      <button className="btn-secondary ml-3 min-h-11" onClick={() => setRetry(value => value + 1)}>Open reader again</button>
    </div>}
    {!client && descriptor?.state !== 'download-only' && !error && <p role="status" className="p-6">Preparing book...</p>}
    {descriptor?.state === 'download-only' && <p role="status" className="p-6">{descriptor.reason}</p>}
    {client && (!started || state === 'conflict') && <section aria-label="Saved position" className="mb-3 rounded bg-dark-100 p-4">
      <p className="mb-3 text-gray-300">{!client.compatible ? 'The original or reader policy changed. Your previous position is retained, but cannot be applied to this version.' :
        state === 'conflict' ? 'Choose the saved position, or explicitly continue writing from here.' : 'A private saved position is available.'}</p>
      <div className="flex flex-wrap gap-3">
        {client.compatible && client.current && <button className="btn-primary min-h-11" onClick={() => void resume(true)}>Resume saved position</button>}
        {state === 'conflict' && client.compatible && <button className="btn-secondary min-h-11" onClick={() => void resume(false, true)}>Continue here</button>}
        <button className="btn-secondary min-h-11" onClick={() => void resume(false)}>Start from beginning</button>
      </div>
    </section>}
    {started && file?.extension === 'epub' && <iframe ref={frame} title="EPUB reader" sandbox="allow-scripts" className="min-h-0 w-full flex-1 rounded-lg border-0" />}
    {started && file?.extension === 'pdf' && <div ref={pdfContainer} data-testid="pdf-reader" className="min-h-0 w-full flex-1" />}
  </main>;
};
