import fs from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect, signIn, capture } from './harness';

test.use({ shortReaderFixtures: true, epubLabelCss: true });

declare global {
  interface Window {
    labelListenerCounts: WeakMap<EventTarget, Map<string, Set<EventListenerOrEventListenerObject>>>;
  }
}

async function open(page: Page) {
  await page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true }).click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  const reader = page.frameLocator('iframe');
  await expect(reader.getByRole('heading', { name: 'Short section 1' })).toBeVisible();
  return { reader, entries: reader.locator('[data-section]'), viewport: reader.locator('#viewport'),
    labels: reader.locator('[data-reader-page-label]'), contents: reader.getByLabel('Contents') };
}

async function geometry(viewport: Locator, entries: Locator) {
  return {
    viewport: await viewport.evaluate(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height, top: element.scrollTop, scrollHeight: element.scrollHeight };
    }),
    entries: await entries.evaluateAll(elements => elements.map(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { section: element.getAttribute('data-section'), x, y, width, height };
    })),
  };
}

test('EPUB book CSS cannot suppress hover or focus labels or change canonical selection', async ({ page, app }, info) => {
  await signIn(page, app);
  const { entries, viewport, labels } = await open(page);
  await expect(entries).toHaveCount(2);
  const first = entries.first(), second = entries.nth(1);
  const article = second.locator('article');
  const original = await article.innerHTML();
  await expect(article.locator('span')).toHaveCSS('display', 'none');
  await expect(article.locator('p')).toHaveCSS('color', 'rgb(17, 68, 102)');
  await expect(article.locator('div')).toHaveCSS('border-top-width', '3px');
  await viewport.evaluate(element => {
    const next = document.getElementById('book')!.shadowRoot!.querySelector('[data-section="1"]')!;
    element.scrollTop += next.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientHeight / 2;
  });
  await viewport.focus();
  await page.mouse.move(0, 0);
  await expect(second.locator('[data-reader-page-label]')).toBeHidden();
  const before = await geometry(viewport, entries);
  const view = (await viewport.boundingBox())!, box = (await second.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, Math.max(view.y + 10, box.y + 10));
  await capture(page, 'epub-css-second-hover', info);
  const label = second.locator('[data-reader-page-label]');
  const observation = {
    before, hovered: await geometry(viewport, entries), original,
    label: await label.evaluate(element => ({ text: element.textContent, display: getComputedStyle(element).display,
      visibility: getComputedStyle(element).visibility, width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height })),
    bookSpanDisplay: await article.locator('span').evaluate(element => getComputedStyle(element).display),
  };
  await fs.writeFile(info.outputPath('css-isolation-observation.json'), JSON.stringify(observation, null, 2));
  await expect(label).toBeVisible();
  await expect(label).toHaveText('Section 2 of 5');
  await expect(first.locator('[data-reader-page-label]')).toBeHidden();
  expect(await geometry(viewport, entries)).toEqual(before);
  expect(await article.innerHTML()).toBe(original);
  await expect(label).toHaveCSS('pointer-events', 'none');
  await page.mouse.move(0, 0);
  await expect(label).toBeHidden();
  await second.focus();
  await expect(second).toBeFocused();
  await expect(label).toBeVisible();
  await capture(page, 'epub-css-second-focus', info);
  expect(await geometry(viewport, entries)).toEqual(before);
  expect(await article.innerHTML()).toBe(original);
  expect(await labels.count()).toBe(2);
  await viewport.focus();
  await expect(label).toBeHidden();
  // Test reading selection without changing focus: WebKit clears a selection
  // when focus is explicitly moved to a different element.
  await article.locator('p').click();
  const selectionBefore = await article.locator('p').evaluate(element => {
    const text = element.firstChild!;
    const selection = getSelection()!;
    selection.setBaseAndExtent(text, 0, text, text.textContent!.length);
    return selection.toString();
  });
  expect(selectionBefore).toBe('Read this line in order.');
  await page.mouse.move(0, 0);
  await page.mouse.move(box.x + box.width / 2, Math.max(view.y + 10, box.y + 10));
  await expect(label).toBeVisible();
  expect(await article.evaluate(() => getSelection()!.toString())).toBe(selectionBefore);
  expect(await geometry(viewport, entries)).toEqual(before);
  expect(await article.innerHTML()).toBe(original);
  await fs.writeFile(info.outputPath('css-selection-observation.json'), JSON.stringify({
    selectionBefore, selectionAfterHover: await article.evaluate(() => getSelection()!.toString()),
  }, null, 2));
});

test('EPUB isolated labels release nodes and listeners across continuous and paged turnover', async ({ page, app }, info) => {
  await page.addInitScript(() => {
    window.labelListenerCounts = new WeakMap();
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    const tracked = (target: EventTarget, type: string) => target instanceof HTMLElement &&
      ((target.hasAttribute('data-reader-labelled-page') && ['pointerenter', 'pointerleave', 'focus', 'blur'].includes(type)) ||
        (target.id === 'viewport' && type === 'scroll'));
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (listener && tracked(this, type)) {
        let counts = window.labelListenerCounts.get(this);
        if (!counts) { counts = new Map(); window.labelListenerCounts.set(this, counts); }
        let listeners = counts.get(type);
        if (!listeners) { listeners = new Set(); counts.set(type, listeners); }
        listeners.add(listener);
      }
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function(type, listener, options) {
      if (listener) window.labelListenerCounts.get(this)?.get(type)?.delete(listener);
      return remove.call(this, type, listener, options);
    };
  });
  const originalRequests: string[] = [], resources: string[] = [];
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (/\/content$|\/downloads\//.test(pathname)) originalRequests.push(pathname);
    if (/\/readers\/[^/]+\/resources\//.test(pathname)) resources.push(pathname);
  });
  await signIn(page, app);
  const { reader, entries, viewport, labels, contents } = await open(page);
  await expect(entries).toHaveCount(2);
  const retired = await entries.first().evaluateHandle(element => {
    const root = element.shadowRoot ?? element;
    return { element, label: root.querySelector('[data-reader-page-label]')!,
      style: [...root.querySelectorAll('style')].find(style => style.textContent?.includes('[data-reader-page-label]'))! };
  });
  const observations: object[] = [];
  try {
    for (const mode of ['continuous', 'paged', 'continuous', 'paged']) {
      await page.getByLabel('Reading mode').selectOption(mode);
      for (const index of [2, 4, 1, 3, 0]) {
        await contents.selectOption(String(index));
        await expect(reader.getByRole('status')).toHaveText(`Section ${index + 1} of 5`);
        const count = mode === 'paged' ? 1 : index === 0 || index === 4 ? 2 : 3;
        await expect(entries).toHaveCount(count);
        await expect(labels).toHaveCount(count);
        const entry = reader.locator(`[data-section="${index}"]`);
        await entry.focus();
        await expect(entry).toBeFocused();
        await expect(entry.locator('[data-reader-page-label]')).toBeVisible();
        await expect(entry.locator('[data-reader-page-label]')).toHaveText(`Section ${index + 1} of 5`);
        await expect(entry.locator('article span')).toHaveCSS('display', 'none');
        const counts = await viewport.evaluate(element => {
          const retained = [...document.getElementById('book')!.shadowRoot!.querySelectorAll('[data-section]')];
          return {
            scroll: window.labelListenerCounts.get(element)?.get('scroll')?.size ?? 0,
            entries: retained.map(entry => [...(window.labelListenerCounts.get(entry)?.values() ?? [])].reduce((sum, set) => sum + set.size, 0)),
            styles: retained.map(entry => [...(entry.shadowRoot ?? entry).querySelectorAll('style')]
              .filter(style => style.textContent?.includes('[data-reader-page-label]')).length),
          };
        });
        // The viewport also retains location reporting and touch-gesture cancellation.
        expect(counts).toEqual({ scroll: count + 2, entries: Array(count).fill(4), styles: Array(count).fill(1) });
        const fetching = resources.length, before = await geometry(viewport, entries);
        await viewport.focus(); await entry.focus();
        expect(resources.length).toBe(fetching);
        expect(await geometry(viewport, entries)).toEqual(before);
        observations.push({ mode, index, count, counts, resources: fetching });
      }
    }
    expect(await retired.evaluate(({ element, label, style }) => ({
      connected: element.isConnected, labelParent: label.parentNode !== null, styleParent: style.parentNode !== null,
      listeners: [...(window.labelListenerCounts.get(element)?.values() ?? [])].reduce((sum, set) => sum + set.size, 0),
    }))).toEqual({ connected: false, labelParent: false, styleParent: false, listeners: 0 });
    expect(originalRequests).toEqual([]);
    await fs.writeFile(info.outputPath('css-turnover-observations.json'), JSON.stringify({ observations, originalRequests }, null, 2));
  } finally { await retired.dispose(); }
});
