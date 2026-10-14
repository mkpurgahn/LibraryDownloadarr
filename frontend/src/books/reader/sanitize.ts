import DOMPurify from 'dompurify';
import { safeCss } from './cssPolicy';
import { resourceReference } from './policy';

const forbidden = ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select',
  'base', 'meta', 'template', 'audio', 'video', 'source', 'foreignObject', 'animate', 'set', 'animateMotion', 'animateTransform'];
export function safeSvg(value: string): string {
  return DOMPurify.sanitize(value, {
    USE_PROFILES: { svg: true }, FORBID_TAGS: [...forbidden, 'style', 'image', 'use'],
    FORBID_ATTR: ['style', 'href', 'xlink:href', 'src'],
  });
}
export async function safeDocument(
  value: string, asset: (reference: string) => Promise<string>, stylesheet: (reference: string) => Promise<string>
): Promise<DocumentFragment> {
  const clean = DOMPurify.sanitize(value, {
    WHOLE_DOCUMENT: true, RETURN_DOM: true, FORBID_TAGS: forbidden,
    FORBID_ATTR: ['srcset', 'ping', 'target', 'download', 'autofocus', 'contenteditable', 'formaction', 'action', 'xmlns:xlink'],
    ALLOWED_URI_REGEXP: /^book-resource:[a-f0-9]{64}(?:#\S*)?$/,
  });
  if (!(clean instanceof HTMLElement)) throw new Error('Cannot read safely here; download original.');
  const fragment = document.createDocumentFragment();
  for (const node of [...clean.querySelectorAll('link')]) {
    if (node.getAttribute('rel') === 'stylesheet') {
      const css = await stylesheet(node.getAttribute('href') ?? '');
      const style = document.createElement('style'); style.textContent = css; fragment.append(style);
    }
    node.remove();
  }
  for (const style of [...clean.querySelectorAll('style')]) {
    style.textContent = await safeCss(style.textContent ?? '', asset);
    fragment.append(style);
  }
  for (const node of [...clean.querySelectorAll('*')]) {
    const inline = node.getAttribute('style');
    if (inline) node.setAttribute('style', await safeCss(inline, asset, true));
    for (const attr of ['src', 'href', 'xlink:href', 'poster']) {
      const value = node.getAttribute(attr);
      if (!value) continue;
      node.removeAttribute(attr);
      if (node.localName === 'a' && attr === 'href') {
        if (resourceReference(value)) { node.setAttribute('data-book-target', value); node.setAttribute('href', '#'); }
      } else if (node.localName === 'img' && attr === 'src') {
        node.setAttribute('src', await asset(value));
        node.setAttribute('loading', 'eager');
      }
    }
  }
  const body = clean.querySelector('body');
  if (!body) throw new Error('Cannot read safely here; download original.');
  const content = document.createElement('article'); content.className = 'book-content';
  content.append(...body.childNodes);
  fragment.append(content);
  return fragment;
}
