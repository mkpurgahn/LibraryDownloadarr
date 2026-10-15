import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { Sidebar, LibraryIcon } from '../components/Sidebar';
import { MediaGrid } from '../components/MediaGrid';
import { api } from '../services/api';
import { MediaItem } from '../types';
import { useAuthStore } from '../stores/authStore';
import { useMobileMenu } from '../hooks/useMobileMenu';
import { useLibraryNavigation } from '../hooks/useLibraryNavigation';
import { HistoryIcon, SettingsIcon } from '../components/Icons';

export const Dashboard: React.FC = () => {
  const [recentlyAdded, setRecentlyAdded] = useState<MediaItem[]>([]);
  const [stats, setStats] = useState<{ count: number; total_size: number | null } | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [mediaError, setMediaError] = useState(false);
  const { user, sessionRevision } = useAuthStore();
  const { isMobileMenuOpen, toggleMobileMenu, closeMobileMenu } = useMobileMenu();
  const navigation = useLibraryNavigation();

  useEffect(() => {
    let current = true;
    setRecentlyAdded([]); setStats(null); setIsLoading(true); setMediaError(false); setStatsError(false);
    void api.getRecentlyAdded(100).then(media => {
      if (current) setRecentlyAdded(media);
    }).catch(error => {
      if (!current) return;
      console.error('Failed to load recently added Plex media:', error);
      setMediaError(true);
    }).finally(() => { if (current) setIsLoading(false); });
    if (user?.isAdmin) {
      void api.getDownloadStats().then(data => {
        if (current) setStats(data);
      }).catch(error => {
        if (!current) return;
        console.error('Failed to load download stats:', error);
        setStatsError(true);
      });
    }
    return () => { current = false; };
  }, [user?.isAdmin, sessionRevision]);

  const formatBytes = (bytes: number | null) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Header onMenuClick={toggleMobileMenu} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={isMobileMenuOpen} onClose={closeMobileMenu} navigation={navigation} />
        <main className="min-w-0 flex-1 overflow-y-auto p-4 pb-24 md:p-8 md:pb-24">
          <div className="mx-auto max-w-7xl">
            <h2 className="mb-6 text-2xl font-bold md:text-3xl">Home</h2>
            <section aria-label="Libraries" className="mb-8">
              <h3 className="mb-3 text-xl font-semibold">Libraries</h3>
              <div className="flex flex-wrap gap-3">
                {navigation.destinations.map(library => <Link key={library.key}
                  to={library.path} className="library-destination">
                  <LibraryIcon type={library.type} />
                  <span className="min-w-0 flex-1 break-words">{library.title}</span>
                  <span aria-hidden="true" className="text-gray-400">&rarr;</span>
                </Link>)}
              </div>
              {navigation.plexLoading && <p role="status" className="mt-3 text-sm text-gray-400">Loading Plex libraries...</p>}
              {navigation.plexError && <p role="status" className="mt-3 text-sm text-gray-400">Plex libraries unavailable. Reload to try again.</p>}
              {!navigation.plexLoading && !navigation.plexError && !navigation.libraries.length &&
                <p className="mt-3 text-sm text-gray-400">No Plex libraries available.</p>}
              {navigation.booksUnavailable && <p role="status" className="mt-3 text-sm text-gray-400">Books and Ebooks are temporarily unavailable. Open either category to retry.</p>}
            </section>

            {user?.isAdmin && <section aria-label="Management"
              className="mb-8 flex flex-wrap items-center gap-x-6 gap-y-1 border-y border-dark-50 py-2 text-sm text-gray-400">
              <Link to="/admin/download-history" className="utility-link flex-wrap">
                <HistoryIcon className="h-4 w-4 flex-none" /><span className="text-gray-200">Downloads</span>
                {stats && <span className="tabular-nums">{stats.count || 0} total &middot; {formatBytes(stats.total_size)}</span>}
                {statsError && <span>Stats unavailable</span>}
              </Link>
              <Link to="/settings" className="utility-link">
                <SettingsIcon className="h-4 w-4 flex-none" /><span>Settings</span>
              </Link>
            </section>}

            <section aria-labelledby="recently-added-heading">
              <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 id="recently-added-heading" className="text-xl font-semibold">Recently Added</h3>
                <span className="text-sm text-gray-400">Plex</span>
              </div>
              {isLoading ? <p role="status" className="py-8 text-gray-400">Loading recently added media...</p>
                : mediaError ? <p role="alert" className="py-8 text-gray-400">Recently added Plex media is unavailable. Reload to try again.</p>
                : recentlyAdded.length > 0 ? <MediaGrid media={recentlyAdded} />
                : <p className="py-8 text-gray-400">No recently added media found. Make sure your Plex server is configured in Settings.</p>}
            </section>
          </div>
        </main>
      </div>
    </div>
  );
};
