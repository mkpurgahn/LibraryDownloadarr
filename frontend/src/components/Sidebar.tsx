import React, { useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useLibraryNavigation, LibraryNavigation } from '../hooks/useLibraryNavigation';
import { DocumentIcon, FilmIcon, FolderIcon, HistoryIcon, HomeIcon, MusicIcon, SettingsIcon, TvIcon } from './Icons';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  navigation?: LibraryNavigation;
}

export function LibraryIcon({ type }: { type: string }) {
  const Icon = type === 'movie' ? FilmIcon : type === 'show' ? TvIcon : type === 'artist' ? MusicIcon : FolderIcon;
  return <Icon className="h-5 w-5 flex-none" />;
}

function ConnectedSidebar(props: Omit<SidebarProps, 'navigation'>) {
  const navigation = useLibraryNavigation();
  return <SidebarContent {...props} navigation={navigation} />;
}

export const Sidebar: React.FC<SidebarProps> = ({ navigation, ...props }) => navigation
  ? <SidebarContent {...props} navigation={navigation} />
  : <ConnectedSidebar {...props} />;

function SidebarContent({ isOpen, onClose, navigation }: SidebarProps & { navigation: LibraryNavigation }) {
  const { libraries, plexLoading, plexError, booksVisible } = navigation;
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore(state => state.user);
  const aside = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!isOpen || window.matchMedia('(min-width: 768px)').matches) return;
    const previous = document.activeElement;
    const panel = aside.current;
    panel?.querySelector<HTMLButtonElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const buttons = panel?.querySelectorAll<HTMLButtonElement>('button');
      if (!buttons?.length) return;
      const first = buttons[0]; const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [isOpen]);

  const active = (path: string) => path === '/books'
    ? location.pathname === '/books' || location.pathname.startsWith('/books/')
    : location.pathname === path;
  const go = (path: string) => { navigate(path); onClose(); };
  const itemClass = (path: string) => `navigation-item ${active(path)
    ? 'bg-primary-500/10 text-primary-300'
    : 'text-gray-300 hover:bg-dark-200 hover:text-white'}`;

  return (
    <>
      {isOpen && <button type="button" aria-label="Close navigation"
        className="fixed inset-0 z-40 bg-black/60 md:hidden" tabIndex={-1} onClick={onClose} />}
      <aside ref={aside}
        className={`fixed inset-y-0 left-0 z-50 w-64 flex-none overflow-y-auto border-r border-dark-50 bg-dark-100
          md:static md:z-auto ${isOpen ? 'visible' : 'invisible md:visible'}`}
        style={{
          paddingTop: 'calc(1rem + env(safe-area-inset-top))',
          paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))',
          paddingLeft: 'calc(1rem + env(safe-area-inset-left))',
          paddingRight: '1rem',
        }}>
        <nav aria-label="Main navigation" className="space-y-8">
          <button onClick={() => go('/')} aria-current={active('/') ? 'page' : undefined} className={itemClass('/')}>
            <HomeIcon className="h-5 w-5 flex-none" /><span>Home</span>
          </button>
          <section aria-label="Libraries">
            <h2 className="mb-2 px-3 text-sm font-medium text-gray-400">Libraries</h2>
            <div className="space-y-1">
              {plexLoading && <p role="status" className="px-3 py-3 text-sm text-gray-400">Loading Plex libraries...</p>}
              {plexError && <p role="status" className="px-3 py-3 text-sm text-gray-400">Plex libraries unavailable.</p>}
              {libraries.map(library => (
                <button key={library.key} onClick={() => go(`/library/${library.key}`)}
                  aria-current={active(`/library/${library.key}`) ? 'page' : undefined}
                  className={itemClass(`/library/${library.key}`)}>
                  <LibraryIcon type={library.type} /><span className="min-w-0 break-words">{library.title}</span>
                </button>
              ))}
              {booksVisible && <button onClick={() => go('/books')}
                aria-current={active('/books') ? 'page' : undefined} className={itemClass('/books')}>
                <DocumentIcon className="h-5 w-5 flex-none" /><span>Books</span>
              </button>}
            </div>
          </section>
          {user?.isAdmin && <section aria-label="Management" className="border-t border-dark-50 pt-6">
            <h2 className="mb-2 px-3 text-sm font-medium text-gray-400">Management</h2>
            <div className="space-y-1 text-sm">
              <button onClick={() => go('/admin/download-history')}
                aria-current={active('/admin/download-history') ? 'page' : undefined} className={itemClass('/admin/download-history')}>
                <HistoryIcon className="h-5 w-5 flex-none" /><span>Download History</span>
              </button>
              <button onClick={() => go('/admin/logs')}
                aria-current={active('/admin/logs') ? 'page' : undefined} className={itemClass('/admin/logs')}>
                <DocumentIcon className="h-5 w-5 flex-none" /><span>Logs</span>
              </button>
              <button onClick={() => go('/settings')}
                aria-current={active('/settings') ? 'page' : undefined} className={itemClass('/settings')}>
                <SettingsIcon className="h-5 w-5 flex-none" /><span>Settings</span>
              </button>
            </div>
          </section>}
        </nav>
      </aside>
    </>
  );
}
