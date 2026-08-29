import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../services/api';
import { Library } from '../types';
import { useAuthStore } from '../stores/authStore';
import {
  DocumentIcon,
  FilmIcon,
  FolderIcon,
  HistoryIcon,
  HomeIcon,
  MusicIcon,
  SettingsIcon,
  TvIcon,
} from './Icons';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, onClose }) => {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuthStore();

  useEffect(() => {
    loadLibraries();
  }, []);

  const loadLibraries = async () => {
    try {
      const data = await api.getLibraries();
      setLibraries(data);
    } catch (error) {
      console.error('Failed to load libraries:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const isActive = (path: string) => location.pathname === path;

  const handleNavigate = (path: string) => {
    navigate(path);
    onClose(); // Close mobile menu after navigation
  };

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed md:static inset-y-0 left-0 z-50
          w-64 bg-dark-100 border-r border-dark-50
          transform transition-transform duration-300 ease-in-out
          ${isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}
        style={{
          paddingTop: 'calc(1rem + env(safe-area-inset-top))',
          paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))',
          paddingLeft: 'calc(1rem + env(safe-area-inset-left))',
          paddingRight: '1rem',
        }}
      >
        <nav className="space-y-2">
          <button
            onClick={() => handleNavigate('/')}
            className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-4 py-2 text-left transition-colors ${
              isActive('/') ? 'bg-dark-200 text-primary-400' : 'hover:bg-dark-200'
            }`}
          >
            <HomeIcon className="h-5 w-5 flex-none" />
            <span>Home</span>
          </button>

          {user?.isAdmin && (
            <>
              <button
                onClick={() => handleNavigate('/admin/download-history')}
                className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-4 py-2 text-left transition-colors ${
                  isActive('/admin/download-history') ? 'bg-dark-200 text-primary-400' : 'hover:bg-dark-200'
                }`}
              >
                <HistoryIcon className="h-5 w-5 flex-none" />
                <span>Download History</span>
              </button>
              <button
                onClick={() => handleNavigate('/admin/logs')}
                className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-4 py-2 text-left transition-colors ${
                  isActive('/admin/logs') ? 'bg-dark-200 text-primary-400' : 'hover:bg-dark-200'
                }`}
              >
                <DocumentIcon className="h-5 w-5 flex-none" />
                <span>Logs</span>
              </button>
              <button
                onClick={() => handleNavigate('/settings')}
                className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-4 py-2 text-left transition-colors ${
                  isActive('/settings') ? 'bg-dark-200 text-primary-400' : 'hover:bg-dark-200'
                }`}
              >
                <SettingsIcon className="h-5 w-5 flex-none" />
                <span>Settings</span>
              </button>
            </>
          )}

          {isLoading ? (
            <div className="px-4 py-2 text-sm text-gray-500">Loading libraries...</div>
          ) : (
            <>
              <div className="pt-4 pb-2 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Libraries
              </div>
              {libraries.map((library) => (
                <button
                  key={library.key}
                  onClick={() => handleNavigate(`/library/${library.key}`)}
                  className={`w-full text-left px-4 py-2 rounded-lg transition-colors ${
                    location.pathname === `/library/${library.key}`
                      ? 'bg-dark-200 text-primary-400'
                      : 'hover:bg-dark-200'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {library.type === 'movie' ? (
                      <FilmIcon className="h-5 w-5 flex-none" />
                    ) : library.type === 'show' ? (
                      <TvIcon className="h-5 w-5 flex-none" />
                    ) : library.type === 'artist' ? (
                      <MusicIcon className="h-5 w-5 flex-none" />
                    ) : (
                      <FolderIcon className="h-5 w-5 flex-none" />
                    )}
                    <span className="truncate">{library.title}</span>
                  </div>
                </button>
              ))}
            </>
          )}
        </nav>
      </aside>
    </>
  );
};
