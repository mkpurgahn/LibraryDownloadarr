import { useLocation } from 'react-router-dom';
import { BookCategory } from './types';

// API inventory names are stable; visible destinations follow the user's format labels.
export const bookSections = {
  books: { label: 'Books', role: 'ebook', inventory: 'ebooks' },
  audiobooks: { label: 'Audiobooks', role: 'audio', inventory: 'books' },
} as const;

export function useBookCategory(): BookCategory {
  const { pathname } = useLocation();
  return pathname === '/audiobooks' || pathname.startsWith('/audiobooks/') ? 'audiobooks' : 'books';
}
