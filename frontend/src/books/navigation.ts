import { useLocation } from 'react-router-dom';
import { BookCategory } from './types';

export function useBookCategory(): BookCategory {
  const { pathname } = useLocation();
  return pathname === '/ebooks' || pathname.startsWith('/ebooks/') ? 'ebooks' : 'books';
}
