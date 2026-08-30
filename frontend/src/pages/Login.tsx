import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { PlayIcon } from '../components/Icons';
import { api } from '../services/api';

export const Login: React.FC = () => {
  const [error, setError] = useState('');
  const [isPlexLoading, setIsPlexLoading] = useState(false);
  const navigate = useNavigate();
  const { setUser, setToken, token, user } = useAuthStore();

  // Redirect to home if already logged in
  useEffect(() => {
    if (token && user) {
      navigate('/', { replace: true });
    }
  }, [token, user, navigate]);

  const handlePlexLogin = async () => {
    setError('');
    setIsPlexLoading(true);

    // IMPORTANT: Open window immediately (synchronously) before any async operations
    // Mobile browsers block window.open() if it's not directly in the click handler
    const authWindow = window.open('about:blank', '_blank', 'width=600,height=700');

    try {
      // Generate PIN
      const pin = await api.generatePlexPin();

      // Navigate the already-opened window to Plex auth
      if (authWindow) {
        authWindow.location.href = pin.url;
      } else {
        // Fallback if popup was blocked
        setError('Popup blocked. Please allow popups for this site and try again.');
        setIsPlexLoading(false);
        return;
      }

      // Poll for authentication
      const maxAttempts = 60; // 2 minutes (60 * 2 seconds)
      let attempts = 0;

      const pollInterval = setInterval(async () => {
        attempts++;

        try {
          const response = await api.authenticatePlexPin(pin.id);
          clearInterval(pollInterval);
          setUser(response.user);
          setToken(response.token);
          setIsPlexLoading(false);
          navigate('/');
        } catch (err: any) {
          // Check if this is a 403 (access denied) error
          if (err.response?.status === 403) {
            clearInterval(pollInterval);
            setError(err.response?.data?.error || 'Access denied. You do not have access to this Plex server.');
            setIsPlexLoading(false);
            return;
          }

          if (err.response?.status === 401) {
            clearInterval(pollInterval);
            setError(err.response?.data?.error || 'Plex authorization expired. Please start sign-in again.');
            setIsPlexLoading(false);
            return;
          }

          // Check if this is a 500 (server error) - likely machine ID not configured
          if (err.response?.status === 500) {
            clearInterval(pollInterval);
            setError(err.response?.data?.error || 'Server error. Please contact the administrator.');
            setIsPlexLoading(false);
            return;
          }

          if (err.response?.status === 429) {
            clearInterval(pollInterval);
            const retryAfter = Number(err.response.headers?.['retry-after']);
            const waitMinutes = Number.isFinite(retryAfter)
              ? Math.max(1, Math.ceil(retryAfter / 60))
              : undefined;
            setError(
              waitMinutes
                ? `Too many Plex sign-in checks. Try again in about ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'}.`
                : 'Too many Plex sign-in checks. Try again after the rate limit resets.'
            );
            setIsPlexLoading(false);
            return;
          }

          // Check for timeout
          if (attempts >= maxAttempts) {
            clearInterval(pollInterval);
            setError('Plex authentication timeout. Please try again.');
            setIsPlexLoading(false);
          }
          // Continue polling for 400 errors (not yet authorized)
        }
      }, 2000);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to initiate Plex login');
      setIsPlexLoading(false);
      // Close the blank window if PIN generation failed
      if (authWindow) {
        authWindow.close();
      }
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark p-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-6 md:mb-8">
          <h1 className="mb-2 text-3xl font-bold text-white md:text-4xl">
            LibraryDownloadarr
          </h1>
          <p className="text-sm md:text-base text-gray-400">Your media library, ready to download</p>
        </div>

        <div className="card p-6 md:p-8">
          {/* Primary: Plex Login */}
          <div className="text-center mb-6">
            <h2 className="text-xl md:text-2xl font-bold mb-2">Sign In</h2>
            <p className="text-sm md:text-base text-gray-400">Use your Plex account to get started</p>
          </div>

          <button
            onClick={handlePlexLogin}
            disabled={isPlexLoading}
            className="btn-primary w-full flex items-center justify-center space-x-3 text-base md:text-lg py-4 font-semibold shadow-lg hover:shadow-xl transition-shadow"
          >
            <PlayIcon className="h-6 w-6" />
            <span>{isPlexLoading ? 'Waiting for Plex...' : 'Sign in with Plex'}</span>
          </button>

          {isPlexLoading && (
            <div className="mt-4 p-4 bg-primary-500/10 border border-primary-500/20 rounded-lg">
              <p className="text-xs md:text-sm text-gray-300 text-center">
                <strong>Waiting for authorization...</strong>
                <br />
                Complete the login in the popup window.
              </p>
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-lg text-xs md:text-sm mt-4">
              {error}
            </div>
          )}

          <div className="mt-6 border-t border-dark-50 pt-5 text-center">
            <p className="text-xs leading-relaxed text-gray-500">
              The configured Plex server owner receives administrator controls
              automatically after Plex verifies the account.
            </p>
          </div>
        </div>

        <div className="mt-6 text-center">
          <p className="text-xs text-gray-500">
            Access is limited to Plex accounts that share this server.
          </p>
        </div>
      </div>
    </div>
  );
};
