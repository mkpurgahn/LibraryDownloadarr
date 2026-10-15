import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { Header } from '../components/Header';
import { Sidebar } from '../components/Sidebar';
import { useMobileMenu } from '../hooks/useMobileMenu';
import { useDownloads } from '../contexts/DownloadContext';
import { useAuthStore } from '../stores/authStore';
import { booksApi, aborted, booksErrorMessage, BOOKS_CHANGED_EVENT } from './api';
import { BookFile, BookItem, READ_LIMITS } from './types';
import { BookCover } from './BooksPage';
import { useBookAudio } from './AudioProvider';
import { bookSections, useBookCategory } from './navigation';

const fileSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const BookDetail: React.FC = () => {
  const { itemId } = useParams<{ itemId: string }>();
  const category = useBookCategory();
  const { label, role } = bookSections[category];
  const menu = useMobileMenu();
  const sessionRevision = useAuthStore(state => state.sessionRevision);
  const { startBookDownloads } = useDownloads();
  const audio = useBookAudio();
  const [item, setItem] = useState<BookItem>();
  const [ebook, setEbook] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [starting, setStarting] = useState(false);
  const [shown, setShown] = useState(50);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { heading.current?.focus(); }, [item?.itemId]);
  useEffect(() => {
    const controller = new AbortController();
    const changed = () => {
      controller.abort(); setItem(undefined); setError(`Library configuration changed. Reopen ${label} to load the current library.`);
    };
    window.addEventListener(BOOKS_CHANGED_EVENT, changed);
    setItem(undefined); setError(''); setNotice(''); setShown(50);
    if (itemId) void booksApi.item(itemId, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setItem(value); setEbook(value.files.find(file => file.role === 'ebook' && file.available)?.fileId ?? '');
    }).catch(error => { if (!aborted(error)) setError(booksErrorMessage(error)); });
    return () => { controller.abort(); window.removeEventListener(BOOKS_CHANGED_EVENT, changed); };
  }, [itemId, sessionRevision, label]);
  const files = item?.files.filter(file => file.role === role) ?? [];
  const download = async (files: BookFile[]) => {
    if (!item) return;
    setStarting(true); setNotice(''); setError('');
    try {
      const result = await startBookDownloads(files.filter(file => file.available && file.role === role).map(file => ({
        source: 'abs', providerInstanceId: item.providerInstanceId, libraryId: item.libraryId,
        itemId: item.itemId, fileId: file.fileId, contentVersion: file.contentVersion,
        title: item.title, filename: file.basename,
      })));
      setNotice(`${result.started} sent to your browser. ${result.failed ? `${result.failed} need attention.` : 'Other prepared files have individual Save file links.'}`);
    } catch (error) { if (!aborted(error)) setError(booksErrorMessage(error)); }
    finally { setStarting(false); }
  };
  const selected = files.find(file => file.fileId === ebook);
  const oversized = selected && (selected.extension === 'cbz' ? selected.size > READ_LIMITS.cbz :
    selected.extension === 'epub' ? selected.size > READ_LIMITS.epub : selected.extension === 'pdf' && selected.size > READ_LIMITS.pdf);
  const readable = selected?.available && ['epub', 'pdf', 'cbz'].includes(selected.extension) && !oversized;
  if (item && item.itemId === itemId && !files.length && item.files.length) {
    return <Navigate replace to={`/${role === 'ebook' ? 'audiobooks' : 'books'}/items/${item.itemId}`} />;
  }
  return (
    <div className="min-h-screen flex flex-col">
      <Header onMenuClick={menu.toggleMobileMenu} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={menu.isMobileMenuOpen} onClose={menu.closeMobileMenu} />
        <main className="min-w-0 flex-1 overflow-y-auto p-4 pb-24 md:p-8">
          <div className="mx-auto max-w-5xl">
            <Link tabIndex={0} className="inline-flex min-h-11 items-center text-sm text-primary-300 hover:underline" to={`/${category}`}>Back to {label}</Link>
            {error && <p role="alert" className="my-4 rounded-lg bg-red-500/10 p-4 text-red-200">{error}</p>}
            {!item && !error && <p role="status" className="py-12 text-gray-400">Loading book...</p>}
            {item && <>
              <div className="mt-4 grid items-start gap-6 sm:grid-cols-[11rem_minmax(0,1fr)]">
                <div className="mx-auto w-40 sm:w-full"><BookCover itemId={item.itemId} title={item.title} /></div>
                <div className="min-w-0">
                  <h1 ref={heading} tabIndex={-1} className="break-words text-2xl font-bold outline-none md:text-3xl">{item.title}</h1>
                  <p className="mt-2 text-gray-300">{item.authors.join(', ') || 'Author unavailable'}</p>
                  {role === 'audio' && item.narrators.length > 0 && <p className="mt-1 text-sm text-gray-400">Narrated by {item.narrators.join(', ')}</p>}
                  {item.series.length > 0 && <p className="mt-1 text-sm text-gray-400">{item.series.join(', ')}</p>}
                  <p className="mt-4 whitespace-pre-line text-sm leading-6 text-gray-300">{item.description || 'No description available.'}</p>
                  {role === 'ebook' && files.length > 0 && <label className="mt-5 block text-sm">Ebook original
                    <select className="input mt-1 min-h-11" style={{ colorScheme: 'dark' }} value={ebook} onChange={event => setEbook(event.target.value)}>
                      {files.map(file => <option key={file.fileId} value={file.fileId} disabled={!file.available}>{file.basename}</option>)}
                    </select>
                  </label>}
                  {files.length > 0 && <div className="mt-4 flex flex-wrap gap-3">
                    {role === 'ebook' ? readable
                      ? <Link tabIndex={0} className="btn-primary min-h-11" to={`/books/items/${item.itemId}/read/${ebook}`}>Read</Link>
                      : <button className="btn-secondary min-h-11" disabled>Read</button>
                      : <button className="btn-primary min-h-11" disabled={!item.listen.available}
                        onClick={() => void audio.open(item)}>Listen</button>}
                  </div>}
                  {role === 'ebook' && files.length > 0 && !readable && <p className="mt-2 text-xs text-gray-400">{oversized
                    ? selected?.extension === 'cbz' ? 'This CBZ exceeds the 100 MiB archive limit; download the original below.' :
                      'This original exceeds the in-app reader size limit; download it below.' : item.read.reason || 'This ebook is download-only.'}</p>}
                  {role === 'audio' && files.length > 0 && !item.listen.available && <p className="mt-2 text-xs text-gray-400">{item.listen.reason}</p>}
                </div>
              </div>
              {notice && <p role="status" className="mt-6 rounded-lg bg-primary-500/10 p-4 text-sm text-primary-200">
                {notice}
              </p>}
              <section className="mt-8" aria-label="Original files">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-xl font-semibold">Original files</h2>
                  <button className="btn-secondary min-h-11" disabled={starting || !files.some(file => file.available)}
                    onClick={() => void download(files)}>Prepare all downloads</button>
                </div>
                <p className="mt-3 text-sm leading-6 text-gray-400">
                  {role === 'ebook' ? 'Reading' : 'Audio'} originals only; file contents are unchanged. One file starts automatically; the rest get Save file links so native downloads do not overwhelm the stream limit.
                  Your browser may ask permission for multiple downloads. Books acceleration and ZIPs are not used.
                </p>
                <ul className="mt-4 divide-y divide-white/10 rounded-xl border border-white/10">
                  {files.slice(0, shown).map(file => <li key={file.fileId} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="break-words text-sm font-medium">{file.basename}</div>
                      <div className="mt-1 text-xs text-gray-400">{file.extension.toUpperCase()} / {fileSize(file.size)} / {file.role}{!file.available ? ' / Unavailable' : ''}</div>
                    </div>
                    <button className="btn-secondary min-h-11 flex-none text-sm" disabled={starting || !file.available}
                      aria-label={`Download original ${file.basename}`} onClick={() => void download([file])}>Download original</button>
                  </li>)}
                </ul>
                {!files.length && <p role="status" className="mt-4 text-sm text-gray-400">No {role === 'ebook' ? 'reading' : 'audio'} originals available.</p>}
                {files.length > shown && <button className="btn-secondary mt-4 min-h-11" onClick={() => setShown(value => value + 50)}>Show more originals</button>}
              </section>
            </>}
          </div>
        </main>
      </div>
    </div>
  );
};
