import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { api } from './services/api';
import { Setup } from './pages/Setup';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { LibraryView } from './pages/LibraryView';
import { MediaDetail } from './pages/MediaDetail';
import { Settings } from './pages/Settings';
import { SearchResults } from './pages/SearchResults';
import { DownloadHistory } from './pages/DownloadHistory';
import { Logs } from './pages/Logs';
import { DownloadProvider } from './contexts/DownloadContext';
import { DownloadManager } from './components/DownloadManager';

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token } = useAuthStore();

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};

const AdminRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token, user } = useAuthStore();

  if (!token) {
    return <Navigate to="/login" replace />;
  }
  if (!user?.isAdmin) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
};

const App: React.FC = () => {
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { checkAuth, token, user } = useAuthStore();

  useEffect(() => {
    initialize();
  }, []);

  const initialize = async () => {
    try {
      // Check if setup is required
      const required = await api.checkSetupRequired();
      setSetupRequired(required);

      if (token) {
        await checkAuth();
      }
    } catch (error) {
      console.error('Initialization error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  const routes = (
    <Routes>
      {setupRequired ? (
        <>
          <Route
            path="/setup"
            element={token && user ? <Navigate to="/settings" replace /> : <Setup />}
          />
          <Route
            path="/settings"
            element={
              <AdminRoute>
                <Settings />
              </AdminRoute>
            }
          />
          <Route
            path="*"
            element={<Navigate to={token && user ? '/settings' : '/setup'} replace />}
          />
        </>
      ) : (
        <>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/library/:libraryKey"
            element={
              <ProtectedRoute>
                <LibraryView />
              </ProtectedRoute>
            }
          />
          <Route
            path="/media/:ratingKey"
            element={
              <ProtectedRoute>
                <MediaDetail />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <AdminRoute>
                  <Settings />
                </AdminRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path="/search"
            element={
              <ProtectedRoute>
                <SearchResults />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/download-history"
            element={
              <ProtectedRoute>
                <AdminRoute>
                  <DownloadHistory />
                </AdminRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/logs"
            element={
              <ProtectedRoute>
                <AdminRoute>
                  <Logs />
                </AdminRoute>
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </>
      )}
    </Routes>
  );

  return (
    <BrowserRouter>
      {token && user ? (
        <DownloadProvider key={user.id} userId={user.id}>
          <DownloadManager />
          {routes}
        </DownloadProvider>
      ) : routes}
    </BrowserRouter>
  );
};

export default App;
