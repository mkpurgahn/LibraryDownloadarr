import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SESSION_CHANGED_EVENT } from '../../stores/authStore';
import { BOOKS_CHANGED_EVENT } from '../api';
import type { ReadingMode } from './presentation';
import { CHROME_INTERACTION_EVENT, REVEAL_CONTROLS_EVENT, trackReaderChrome } from './readerOverlays';
import type { ChromeInteraction } from './readerOverlays';

export function useReaderPresentation(userId: string | undefined, identity: string) {
  const root = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const chrome = useRef<HTMLElement>(null);
  const [mode, setMode] = useState<ReadingMode>('continuous');
  const [screen, setScreen] = useState<'normal' | 'native' | 'viewport'>('normal');
  const previousScreen = useRef(screen);
  const [controls, setControls] = useState(false);
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const [notice, setNotice] = useState('');
  const [hint, setHint] = useState('');
  const [chromeTop, setChromeTop] = useState(0);
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const holds = useRef(new Set<EventTarget>());
  const hideTimer = useRef<number>();
  const hintTimer = useRef<number>();
  const focusControls = useRef<'first' | 'last'>();
  const input = useRef('mouse');
  const tap = useRef<{ target: HTMLElement; id: number; x: number; y: number; time: number }>();
  const epoch = useRef(0);
  const key = userId ? `books-reading-mode:${userId}` : undefined;
  const scheduleHide = () => {
    window.clearTimeout(hideTimer.current);
    if (screenRef.current !== 'normal' && !holds.current.size) hideTimer.current = window.setTimeout(() => setControls(false), 800);
  };
  const reveal = () => {
    if (screenRef.current === 'normal') return;
    setControls(true); scheduleHide();
  };
  useLayoutEffect(() => {
    const element = chrome.current;
    if (!element) return;
    const measure = () => setChromeTop(element.offsetHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, [identity]);
  useEffect(() => {
    const element = root.current!, panel = chrome.current!;
    const interaction = (event: Event) => {
      if (!(event instanceof CustomEvent) || !event.target || screenRef.current === 'normal') return;
      const state = event.detail as ChromeInteraction;
      // Entering fullscreen can blur the old trigger while its panel still has
      // pointer hover. Only a corner/keyboard action opens hidden chrome.
      if (!controlsRef.current && !(event.target instanceof HTMLElement && event.target.hasAttribute('data-reader-corner'))) return;
      if (state.hovered || state.focused) { holds.current.add(event.target); setControls(true); window.clearTimeout(hideTimer.current); }
      else { holds.current.delete(event.target); scheduleHide(); }
    };
    const announce = (target: HTMLElement) => trackReaderChrome(target, detail =>
      target.dispatchEvent(new CustomEvent(CHROME_INTERACTION_EVENT, { detail, bubbles: true })));
    element.addEventListener(CHROME_INTERACTION_EVENT, interaction);
    element.addEventListener(REVEAL_CONTROLS_EVENT, reveal);
    const remove = announce(panel);
    const pointer = (event: PointerEvent) => { input.current = event.pointerType; };
    const cancelTap = (event: TouchEvent) => { if (event.touches.length > 1) tap.current = undefined; };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('touchstart', cancelTap, { capture: true, passive: true });
    return () => {
      remove(); element.removeEventListener(CHROME_INTERACTION_EVENT, interaction);
      element.removeEventListener(REVEAL_CONTROLS_EVENT, reveal);
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('touchstart', cancelTap, true);
      window.clearTimeout(hideTimer.current); window.clearTimeout(hintTimer.current); holds.current.clear();
    };
  }, [identity]);
  useLayoutEffect(() => {
    let focus: number | undefined;
    if (previousScreen.current !== 'normal' && screen === 'normal') {
      // Release the embedded document before returning focus to its parent.
      if (document.activeElement instanceof HTMLIFrameElement) document.activeElement.blur();
      focus = requestAnimationFrame(() => {
        // Let the normal header become drawable after an invisible overlay exit.
        focus = requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
      });
      window.clearTimeout(hideTimer.current); window.clearTimeout(hintTimer.current);
      holds.current.clear(); setHint('');
    } else if (previousScreen.current === 'normal' && screen !== 'normal') {
      root.current?.focus({ preventScroll: true });
      setHint(input.current === 'touch' ? 'Tap any corner to show controls or exit fullscreen.' :
        'Press Esc to exit fullscreen. Move your mouse to any corner to show controls.');
      window.clearTimeout(hintTimer.current);
      hintTimer.current = window.setTimeout(() => setHint(''), 4000);
    }
    previousScreen.current = screen;
    return () => { if (focus !== undefined) cancelAnimationFrame(focus); };
  }, [screen]);
  useLayoutEffect(() => {
    if (!controls || screen === 'normal' || !focusControls.current) return;
    const side = focusControls.current; focusControls.current = undefined;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const elements = chrome.current?.querySelectorAll<HTMLElement>('a[href],button,input,select');
        (side === 'last' ? elements?.[elements.length - 1] : elements?.[0])?.focus({ preventScroll: true });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [controls, screen]);
  useEffect(() => {
    if (screen === 'normal') return;
    const corners = root.current!.querySelectorAll<HTMLElement>('[data-reader-corner]');
    const remove = [...corners].map(element => trackReaderChrome(element, detail =>
      element.dispatchEvent(new CustomEvent(CHROME_INTERACTION_EVENT, { detail, bubbles: true }))));
    return () => remove.forEach(dispose => dispose());
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
    holds.current.clear(); setControls(false);
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
    const keydown = (event: KeyboardEvent) => {
      input.current = 'keyboard';
      if (event.key === 'Escape') void exit();
      else if (event.key === 'Tab' && screenRef.current !== 'normal' && !controlsRef.current) {
        event.preventDefault(); focusControls.current = event.shiftKey ? 'last' : 'first'; reveal();
      }
    };
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
  const cornerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0) { tap.current = undefined; return; }
    tap.current = { target: event.currentTarget, id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp };
  };
  const cornerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (tap.current && (event.pointerId !== tap.current.id || Math.hypot(event.clientX - tap.current.x, event.clientY - tap.current.y) > 8)) tap.current = undefined;
  };
  const cornerClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    const previous = tap.current; tap.current = undefined;
    if (event.detail !== 0 && (!previous || previous.target !== event.currentTarget || event.timeStamp - previous.time > 500)) return;
    if (event.detail !== 0) event.currentTarget.blur();
    reveal();
  };
  return { root, trigger, chrome, chromeTop, mode, chooseMode, screen, controls, notice, hint, enter, exit,
    cornerDown, cornerMove, cornerClick, cornerCancel: () => { tap.current = undefined; },
    chromeHidden: screen !== 'normal' && !controls };
}
