import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { Sidebar } from '../components/Sidebar';
import { DocumentIcon } from '../components/Icons';
import { useMobileMenu } from '../hooks/useMobileMenu';
import { useAuthStore } from '../stores/authStore';
import { booksApi, aborted, booksErrorMessage, BOOKS_CHANGED_EVENT } from './api';
import { BookCategory, BookSummary, CatalogQuery } from './types';
import { bookSections } from './navigation';

export function BookCover({ itemId, title }: { itemId: string; title: string }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => setMissing(false), [itemId]);
  return (
    <div className="relative flex aspect-[2/3] items-center justify-center overflow-hidden rounded-lg bg-dark-200 ring-1 ring-white/10">
      <div className="flex flex-col items-center gap-3 px-4 text-center text-gray-500">
        <DocumentIcon className="h-12 w-12" />
        <span className="text-xs">No cover available</span>
      </div>
      {!missing && <img src={booksApi.coverUrl(itemId)} alt={`${title} cover`} loading="lazy"
        className="absolute inset-0 h-full w-full object-cover" onError={() => setMissing(true)} />}
    </div>
  );
}

export const BooksPage: React.FC<{ category: BookCategory }> = ({ category }) => {
  const { label, inventory, role } = bookSections[category];
  const menu = useMobileMenu();
  const sessionRevision = useAuthStore(state => state.sessionRevision);
  const [items, setItems] = useState<BookSummary[]>([]);
  const [query, setQuery] = useState<CatalogQuery>({ page: 0, limit: 50, filter: 'all', sort: 'title', desc: false });
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { heading.current?.focus(); }, [sessionRevision]);
  useEffect(() => {
    const changed = () => setRefresh(value => value + 1);
    window.addEventListener(BOOKS_CHANGED_EVENT, changed);
    return () => window.removeEventListener(BOOKS_CHANGED_EVENT, changed);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setItems([]); setTotal(0);
    void (async () => {
      const libraries = await booksApi.libraries(controller.signal);
      if (controller.signal.aborted) return;
      if (!libraries.length) { setTotal(0); return; }
      const library = libraries[0];
      const result = await booksApi.catalog(library.libraryId, { ...query, category: inventory, ...(search ? { q: search } : {}) }, controller.signal);
      if (controller.signal.aborted) return;
      if (query.page > 0 && query.page * query.limit >= result.total) {
        setQuery(current => ({ ...current, page: Math.max(0, Math.ceil(result.total / query.limit) - 1) }));
        return;
      }
      setItems(result.items); setTotal(result.total);
    })().catch(error => { if (!controller.signal.aborted && !aborted(error)) setError(booksErrorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, search, refresh, sessionRevision, inventory]);

  return (
    <div className="min-h-screen flex flex-col">
      <Header onMenuClick={menu.toggleMobileMenu} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={menu.isMobileMenuOpen} onClose={menu.closeMobileMenu} />
        <main className="min-w-0 flex-1 overflow-y-auto p-4 pb-24 md:p-8">
          <div className="mx-auto max-w-7xl">
            <div className="mb-6">
              <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold outline-none md:text-3xl">{label}</h1>
              <p className="mt-2 text-sm text-gray-400">{role === 'ebook'
                ? 'Reading originals and manga, including download-only formats.'
                : 'Audio originals for listening and download.'}</p>
            </div>
            <form className={`mb-6 grid gap-3 ${role === 'audio'
              ? 'lg:grid-cols-[minmax(15rem,1fr)_14rem_10rem_auto]' : 'lg:grid-cols-[minmax(15rem,1fr)_10rem_auto]'}`} onSubmit={event => {
              event.preventDefault(); setSearch(input.trim()); setQuery(current => ({ ...current, page: 0 }));
            }}>
              <label className="text-sm">Search {category}
                <input className="input mt-1 min-h-11" value={input} maxLength={200} placeholder="Title, subtitle, ISBN or ASIN"
                  onChange={event => setInput(event.target.value)} />
              </label>
              {role === 'audio' && <label className="text-sm">Available sources
                <select className="input mt-1 min-h-11" style={{ colorScheme: 'dark' }} value={query.filter}
                  onChange={event => setQuery(current => ({ ...current, page: 0, filter: event.target.value as CatalogQuery['filter'] }))}>
                  <option value="all">All audio</option>
                  <option value="single">Single-track audio</option><option value="multi">Multi-track audio</option>
                </select>
              </label>}
              <label className="text-sm">Sort
                <select className="input mt-1 min-h-11" style={{ colorScheme: 'dark' }} value={query.sort}
                  onChange={event => setQuery(current => ({ ...current, page: 0, sort: event.target.value as CatalogQuery['sort'] }))}>
                  <option value="title">Title</option><option value="author">Author</option>
                </select>
              </label>
              <button className="btn-primary min-h-11 self-end" type="submit">Search</button>
            </form>
            {search && <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-gray-400">
              <span>Search results in {label}. {role === 'audio' ? 'Source filters, sorting and pagination' : 'Sorting and pagination'} still apply.</span>
              <button className="btn-secondary min-h-11" onClick={() => { setInput(''); setSearch(''); setQuery(current => ({ ...current, page: 0 })); }}>Clear search</button>
            </div>}
            {error && <div role="alert" className="mb-6 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-red-200">
              <p>{error}</p>
              <button className="btn-secondary mt-3 min-h-11" onClick={() => setRefresh(value => value + 1)}>Retry {label}</button>
            </div>}
            {loading ? <p role="status" className="py-12 text-center text-gray-400">Loading {label}...</p> :
              !error && !items.length ? <p role="status" className="py-12 text-center text-gray-400">No {category} found</p> :
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {items.map(item => <Link key={`${item.providerInstanceId}:${item.itemId}`} to={`/${category}/items/${item.itemId}`} tabIndex={0}
                    aria-label={`Open ${item.title}`} className="group rounded-xl p-2 outline-none transition-colors hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-primary-500">
                    <BookCover itemId={item.itemId} title={item.title} />
                    <h2 className="mt-3 line-clamp-2 text-sm font-semibold group-hover:text-primary-300">{item.title}</h2>
                    <p className="mt-1 line-clamp-1 text-xs text-gray-400">{item.authors.join(', ') || 'Author unavailable'}</p>
                    <div className="mt-2 flex flex-wrap gap-1 text-xs text-gray-300">
                      {role === 'ebook' && item.hasEbook && <span className="rounded bg-white/5 px-2 py-1">Reading</span>}
                      {role === 'audio' && item.audioTrackCount > 0 && <span className="rounded bg-white/5 px-2 py-1">{item.audioTrackCount} audio tracks</span>}
                      {(item.missing || item.invalid) && <span className="text-amber-300">Unavailable</span>}
                    </div>
                  </Link>)}
                </div>}
            {!error && !loading && <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-gray-400">{total} {category} - Page {query.page + 1}</p>
              <div className="flex gap-2">
                <button className="btn-secondary min-h-11" disabled={query.page === 0} onClick={() => setQuery(current => ({ ...current, page: current.page - 1 }))}>Previous page</button>
                <button className="btn-secondary min-h-11" disabled={(query.page + 1) * query.limit >= total} onClick={() => setQuery(current => ({ ...current, page: current.page + 1 }))}>Next page</button>
              </div>
            </div>}
          </div>
        </main>
      </div>
    </div>
  );
};
