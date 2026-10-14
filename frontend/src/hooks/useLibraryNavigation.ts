import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { booksApi, BooksApiError, aborted, BOOKS_CHANGED_EVENT } from '../books/api';
import type { Library } from '../types';

export function useLibraryNavigation() {
  const sessionRevision = useAuthStore(state => state.sessionRevision);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [plexLoading, setPlexLoading] = useState(true);
  const [plexError, setPlexError] = useState(false);
  const [booksVisible, setBooksVisible] = useState(false);
  const [booksUnavailable, setBooksUnavailable] = useState(false);

  useEffect(() => {
    let current = true;
    setLibraries([]); setPlexLoading(true); setPlexError(false);
    void api.getLibraries().then(data => {
      if (current) setLibraries(data);
    }).catch(error => {
      if (!current) return;
      console.error('Failed to load Plex libraries:', error);
      setPlexError(true);
    }).finally(() => { if (current) setPlexLoading(false); });
    return () => { current = false; };
  }, [sessionRevision]);

  useEffect(() => {
    let controller: AbortController;
    const refresh = () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      setBooksVisible(false); setBooksUnavailable(false);
      void booksApi.libraries(request.signal).then(data => {
        if (!request.signal.aborted) setBooksVisible(data.length > 0);
      }).catch(error => {
        if (request.signal.aborted || aborted(error)) return;
        const hidden = error instanceof BooksApiError &&
          ['BOOKS_DISABLED', 'PLEX_ACCESS_REQUIRED', 'BOOKS_SESSION_REQUIRED'].includes(error.code);
        setBooksVisible(!hidden);
        setBooksUnavailable(!hidden);
        if (!hidden) console.error('Failed to load Books navigation:', error);
      });
    };
    refresh();
    window.addEventListener(BOOKS_CHANGED_EVENT, refresh);
    return () => { controller.abort(); window.removeEventListener(BOOKS_CHANGED_EVENT, refresh); };
  }, [sessionRevision]);

  return { libraries, plexLoading, plexError, booksVisible, booksUnavailable };
}

export type LibraryNavigation = ReturnType<typeof useLibraryNavigation>;
