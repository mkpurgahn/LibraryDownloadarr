import { create } from 'zustand';
import { User } from '../types';
import { api } from '../services/api';

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  sessionRevision: number;
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const SESSION_CHANGED_EVENT = 'librarydownloadarr:session-changed';
const sessionChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('librarydownloadarr-session') : undefined;
function notifySessionChange(broadcast = true): void {
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
  if (broadcast) sessionChannel?.postMessage({ type: 'session-changed' });
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: localStorage.getItem('token'),
  isLoading: false,
  error: null,
  sessionRevision: 0,

  setUser: (user) => set(state => ({
    user,
    sessionRevision: state.sessionRevision + (state.user?.id !== user?.id ? 1 : 0),
  })),

  setToken: (token) => {
    if (token === get().token) return;
    if (token) {
      localStorage.setItem('token', token);
    } else {
      localStorage.removeItem('token');
    }
    set(state => ({ token, user: null, sessionRevision: state.sessionRevision + 1 }));
    notifySessionChange();
  },

  logout: async () => {
    try {
      await api.logout();
    } catch {
      console.error('Logout request failed; the local session has been cleared.');
    }
    localStorage.removeItem('token');
    set(state => ({ user: null, token: null, sessionRevision: state.sessionRevision + 1 }));
    notifySessionChange();
  },

  checkAuth: async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      set({ user: null, token: null });
      return;
    }

    try {
      const user = await api.getCurrentUser();
      if (localStorage.getItem('token') !== token) return;
      set(state => ({
        user, token,
        sessionRevision: state.sessionRevision + (state.user?.id !== user.id ? 1 : 0),
      }));
    } catch (error) {
      if (localStorage.getItem('token') !== token) return;
      set({ user: null, token: null });
      localStorage.removeItem('token');
      notifySessionChange();
    }
  },
}));

function synchronizeSession(): void {
  useAuthStore.setState(state => ({ user: null, token: null, sessionRevision: state.sessionRevision + 1 }));
  notifySessionChange(false);
  void useAuthStore.getState().checkAuth();
}
window.addEventListener('storage', event => {
  if (event.key === 'token' || event.key === null) synchronizeSession();
});
if (sessionChannel) sessionChannel.onmessage = event => {
  if (event.data?.type === 'session-changed') synchronizeSession();
};
