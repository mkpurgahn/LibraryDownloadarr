export type ReadingMode = 'continuous' | 'paged';
export interface ReaderPresentation { mode: ReadingMode; chromeHidden: boolean }
export const PRESENTATION_EVENT = 'reader-presentation';
export const DEFAULT_PRESENTATION: ReaderPresentation = { mode: 'continuous', chromeHidden: false };

export function touchNavigation(viewport: HTMLElement, turn: (delta: -1 | 1) => void): () => void {
  const document = viewport.ownerDocument;
  let start: { id: number; x: number; y: number; time: number } | undefined;
  let cancelled = false;
  const cancel = () => { start = undefined; cancelled = true; };
  const selection = () => document.getSelection()?.isCollapsed === false;
  const globalStart = (event: TouchEvent) => {
    if (event.touches.length === 1) cancelled = false; else cancel();
  };
  const down = (event: TouchEvent) => {
    if (cancelled || event.touches.length !== 1 || selection()) return;
    const contact = event.touches[0];
    start = { id: contact.identifier, x: contact.clientX, y: contact.clientY, time: event.timeStamp };
  };
  const move = (event: TouchEvent) => {
    if (event.touches.length !== 1 || (start && event.touches[0].identifier !== start.id)) cancel();
  };
  const up = (event: TouchEvent) => {
    if (event.touches.length) { cancel(); return; }
    const contact = event.changedTouches[0], previous = start;
    start = undefined;
    if (!previous || cancelled || event.changedTouches.length !== 1 || contact.identifier !== previous.id ||
        event.timeStamp - previous.time > 500 || selection() || viewport.scrollWidth > viewport.clientWidth + 1) return;
    const dx = contact.clientX - previous.x, dy = contact.clientY - previous.y;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 40) turn(dx < 0 ? 1 : -1);
  };
  const globalEnd = (event: TouchEvent) => { if (event.touches.length) cancel(); };
  document.addEventListener('touchstart', globalStart, { capture: true, passive: true });
  document.addEventListener('touchmove', move, { capture: true, passive: true });
  document.addEventListener('touchend', globalEnd, { capture: true, passive: true });
  document.addEventListener('touchcancel', cancel, { capture: true, passive: true });
  viewport.addEventListener('touchstart', down, { passive: true });
  viewport.addEventListener('touchend', up, { passive: true });
  viewport.addEventListener('scroll', cancel, { passive: true });
  viewport.addEventListener('contextmenu', cancel);
  viewport.addEventListener('reader-cancel-gesture', cancel);
  return () => {
    document.removeEventListener('touchstart', globalStart, true);
    document.removeEventListener('touchmove', move, true);
    document.removeEventListener('touchend', globalEnd, true);
    document.removeEventListener('touchcancel', cancel, true);
    viewport.removeEventListener('touchstart', down);
    viewport.removeEventListener('touchend', up);
    viewport.removeEventListener('scroll', cancel);
    viewport.removeEventListener('contextmenu', cancel);
    viewport.removeEventListener('reader-cancel-gesture', cancel);
  };
}
