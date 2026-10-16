import type { ReaderPresentation } from './presentation';

export const CHROME_INTERACTION_EVENT = 'reader-chrome-interaction';
export const REVEAL_CONTROLS_EVENT = 'reader-reveal-controls';
export interface ChromeInteraction { hovered: boolean; focused: boolean }

export function trackReaderChrome(element: HTMLElement, notify: (state: ChromeInteraction) => void): () => void {
  let hovered = false, disposed = false;
  const report = () => {
    const root = element.getRootNode();
    const active = root instanceof ShadowRoot ? root.activeElement : element.ownerDocument.activeElement;
    if (!disposed) notify({ hovered, focused: active !== null && element.contains(active) });
  };
  const enter = (event: PointerEvent) => { if (event.pointerType !== 'touch') { hovered = true; report(); } };
  const leave = () => { hovered = false; report(); };
  const focus = () => report();
  const blur = () => queueMicrotask(report);
  const focusSelect = (event: PointerEvent) => {
    if (event.target instanceof HTMLSelectElement) event.target.focus({ preventScroll: true });
  };
  element.addEventListener('pointerenter', enter);
  element.addEventListener('pointerleave', leave);
  element.addEventListener('pointerdown', focusSelect);
  element.addEventListener('focusin', focus);
  element.addEventListener('focusout', blur);
  return () => {
    disposed = true;
    element.removeEventListener('pointerenter', enter);
    element.removeEventListener('pointerleave', leave);
    element.removeEventListener('pointerdown', focusSelect);
    element.removeEventListener('focusin', focus);
    element.removeEventListener('focusout', blur);
    notify({ hovered: false, focused: false });
  };
}

export function applyReaderChrome(element: HTMLElement, presentation: ReaderPresentation): void {
  const { overlay, chromeTop, chromeHidden } = presentation;
  Object.assign(element.style, {
    position: overlay ? 'absolute' : '', top: overlay ? `${chromeTop}px` : '',
    left: overlay ? '0' : '', right: overlay ? '0' : '', zIndex: overlay ? '30' : '',
    maxHeight: overlay ? `min(45vh, calc(100% - ${chromeTop}px))` : '',
    overflowY: overlay ? 'auto' : '', boxShadow: overlay ? '0 4px 16px #0006' : '',
    visibility: chromeHidden ? 'hidden' : '',
  });
}

export function pageLabel(element: HTMLElement, viewport: HTMLElement, text: string): () => void {
  const label = document.createElement('span');
  const style = document.createElement('style');
  label.dataset.readerPageLabel = '';
  label.textContent = text;
  label.setAttribute('aria-hidden', 'true');
  label.hidden = true;
  Object.assign(label.style, {
    position: 'fixed', zIndex: '2', right: '8px', top: '8px', pointerEvents: 'none',
    userSelect: 'none', font: '12px/1.4 system-ui', padding: '4px 8px',
    color: '#fff', background: '#181818df', borderRadius: '5px', maxWidth: 'calc(100% - 16px)',
  });
  element.style.position = 'relative';
  element.dataset.readerLabelledPage = '';
  element.tabIndex = 0;
  element.setAttribute('role', 'group'); element.setAttribute('aria-label', text);
  const active = element.shadowRoot ? ':host(:hover),:host(:focus)' : '[data-reader-labelled-page]:hover,[data-reader-labelled-page]:focus';
  style.textContent = `[data-reader-page-label]{visibility:hidden}${active.split(',').map(selector => `${selector}>[data-reader-page-label]`).join(',')}{visibility:visible}`;
  (element.shadowRoot ?? element).append(style, label);
  const update = () => {
    const bounds = element.getBoundingClientRect(), view = viewport.getBoundingClientRect();
    label.hidden = bounds.bottom <= view.top || bounds.top >= view.bottom;
    if (!label.hidden) {
      label.style.top = `${Math.max(view.top + 8, Math.min(bounds.bottom - label.offsetHeight - 8, Math.max(view.top, bounds.top) + 8))}px`;
      label.style.right = `${Math.max(8, element.ownerDocument.documentElement.clientWidth - Math.min(view.right, bounds.right) + 8)}px`;
    }
  };
  const enter = () => update();
  const leave = () => update();
  element.addEventListener('pointerenter', enter); element.addEventListener('pointerleave', leave);
  element.addEventListener('focus', update); element.addEventListener('blur', update);
  viewport.addEventListener('scroll', update, { passive: true });
  return () => {
    element.removeEventListener('pointerenter', enter); element.removeEventListener('pointerleave', leave);
    element.removeEventListener('focus', update); element.removeEventListener('blur', update);
    viewport.removeEventListener('scroll', update); label.remove(); style.remove();
  };
}
