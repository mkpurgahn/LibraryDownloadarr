import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SESSION_CHANGED_EVENT } from '../../stores/authStore';
import { BOOKS_CHANGED_EVENT } from '../api';
import type { ReadingMode } from './presentation';

export function useReaderPresentation(userId: string | undefined, identity: string) {
  const root = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<ReadingMode>('continuous');
  const [screen, setScreen] = useState<'normal' | 'native' | 'viewport'>('normal');
  const previousScreen = useRef(screen);
  const [controls, setControls] = useState(false);
  const [notice, setNotice] = useState('');
  const epoch = useRef(0);
  const key = userId ? `books-reading-mode:${userId}` : undefined;
  useLayoutEffect(() => {
    let focus: number | undefined;
    if (previousScreen.current !== 'normal' && screen === 'normal') {
      // Release the embedded document before returning focus to its parent.
      if (document.activeElement instanceof HTMLIFrameElement) document.activeElement.blur();
      focus = requestAnimationFrame(() => trigger.current?.focus());
    }
    previousScreen.current = screen;
    return () => { if (focus !== undefined) cancelAnimationFrame(focus); };
  }, [screen]);
  useEffect(() => {
    try { setMode(key && localStorage.getItem(key) === 'paged' ? 'paged' : 'continuous'); }
    catch { setNotice('Reading preference could not be loaded in this browser.'); }
  }, [key]);
  const chooseMode = (value: ReadingMode) => {
    setMode(value);
    try { if (key) localStorage.setItem(key, value); }
    catch { setNotice('Reading mode changed, but could not be remembered in this browser.'); }
  };
  const exit = async () => {
    epoch.current++;
    try {
      if (document.fullscreenElement === root.current) await document.exitFullscreen();
      setScreen('normal'); setControls(false);
    } catch { setNotice('Full screen could not close. Press Escape to exit.'); }
  };
  const enter = async () => {
    const element = root.current, current = ++epoch.current;
    if (!element) return;
    setControls(false);
    try {
      if (!document.fullscreenEnabled || !element.requestFullscreen) throw new Error('Fullscreen unavailable');
      await element.requestFullscreen();
      if (current !== epoch.current) {
        if (document.fullscreenElement === element) await document.exitFullscreen();
        return;
      }
      setScreen('native');
    } catch {
      if (current === epoch.current) setScreen('viewport');
    }
  };
  useEffect(() => {
    const element = root.current;
    const changed = () => {
      if (document.fullscreenElement === element) setScreen('native');
      else { setScreen('normal'); setControls(false); }
    };
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') void exit(); };
    const invalidate = () => { void exit(); };
    document.addEventListener('fullscreenchange', changed);
    window.addEventListener('keydown', keydown);
    window.addEventListener(SESSION_CHANGED_EVENT, invalidate);
    window.addEventListener(BOOKS_CHANGED_EVENT, invalidate);
    window.addEventListener('reader-exit-fullscreen', invalidate);
    return () => {
      epoch.current++;
      document.removeEventListener('fullscreenchange', changed);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener(SESSION_CHANGED_EVENT, invalidate);
      window.removeEventListener(BOOKS_CHANGED_EVENT, invalidate);
      window.removeEventListener('reader-exit-fullscreen', invalidate);
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {
        console.warn('Reader full screen could not close during navigation.');
      });
      setScreen('normal'); setControls(false);
    };
  }, [identity]);
  return { root, trigger, mode, chooseMode, screen, controls, setControls, notice, enter, exit,
    chromeHidden: screen !== 'normal' && !controls };
}
