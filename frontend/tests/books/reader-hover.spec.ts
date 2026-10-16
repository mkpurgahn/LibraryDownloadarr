import fs from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect, signIn, capture, revealReaderControls, hideReaderControls } from './harness';
import { parseBookItem, parseProgress } from '../../src/books/types';

type Format = 'cbz' | 'pdf' | 'epub';
test.use({ cbzFixtures: true, hasTouch: true });

function ui(page: Page, format: Format) {
  const owner = format === 'epub' ? page.frameLocator('iframe') : page;
  return {
    viewport: format === 'epub' ? owner.locator('#viewport') : page.getByRole('region', { name: format === 'cbz' ? 'Comic page' : 'PDF pages', exact: true }),
    entries: format === 'epub' ? owner.locator('[data-section]') : page.locator('[data-page]'),
    labels: owner.locator('[data-reader-page-label]'),
    direct: format === 'epub' ? owner.getByLabel('Contents') : page.getByLabel('Page number'),
    option: format === 'cbz' ? page.getByRole('button', { name: 'View options' }) : owner.getByLabel(format === 'pdf' ? 'Zoom' : 'Font size'),
    turns: owner.getByRole('button', { name: /^(Next|Previous) page$/ }),
  };
}
async function open(page: Page, format: Format) {
  const card = page.getByRole('link', { name: format === 'cbz' ? 'Open The Paper Observatory' : 'Open A Tale in Two Formats', exact: true });
  await expect(card.getByRole('img')).toHaveCount(0); await card.click();
  if (format === 'pdf') await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  if (format === 'epub') await expect(page.frameLocator('iframe').getByRole('heading', { name: /section 1|First section/ })).toBeVisible();
  else await expect(page.getByRole('img', { name: format === 'cbz' ? /Comic page 1/ : 'PDF page 1', exact: format === 'pdf' })).toBeVisible();
}
async function corner(page: Page, x: number, y: number) {
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  return { x: x ? size.width - 10 : 10, y: y ? size.height - 10 : 10 };
}
async function away(page: Page, viewport: Locator) {
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75);
}
async function geometry(viewport: Locator, format: Format) {
  return viewport.evaluate((element, format) => {
    const entry = format === 'epub' ? document.getElementById('book')!.shadowRoot!.querySelector<HTMLElement>('[data-section="0"]') :
      element.querySelector<HTMLElement>('[data-page="1"]');
    const box = element.getBoundingClientRect(), bounds = entry!.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, top: element.scrollTop,
      entryX: bounds.x, entryY: bounds.y, entryWidth: bounds.width, entryHeight: bounds.height };
  }, format);
}

test.describe('hovered entry labels', () => {
  test.use({ shortReaderFixtures: true });
  for (const format of ['cbz', 'pdf', 'epub'] as const) test(`${format} label follows the hovered entry without affecting content or geometry`, async ({ page, app }, info) => {
    await signIn(page, app); await open(page, format);
    const reader = ui(page, format);
    await expect(reader.entries).toHaveCount(2);
    await page.mouse.move(0, 0);
    const before = await geometry(reader.viewport, format);
    const content = () => format === 'epub' ? page.frameLocator('iframe').locator('article').allTextContents() :
      format === 'pdf' ? page.locator('.textLayer').allTextContents() : reader.viewport.locator('img').count();
    const original = await content();
    await capture(page, `${format}-labels-before`, info);
    await expect.soft(reader.labels).toHaveCount(2, { timeout: 1000 });
    expect(await reader.labels.evaluateAll(labels => labels.filter(label => (label as HTMLElement).checkVisibility({ checkVisibilityCSS: true })).length)).toBe(0);
    const first = reader.entries.first();
    const second = reader.entries.nth(1);
    // Put the boundary midway down the actual viewport, with both entries visible.
    await reader.viewport.evaluate((element, format) => {
      const next = format === 'epub' ? document.getElementById('book')!.shadowRoot!.querySelector<HTMLElement>('[data-section="1"]')! :
        element.querySelector<HTMLElement>('[data-page="2"]')!;
      element.scrollTop += next.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientHeight / 2;
    }, format);
    const view = (await reader.viewport.boundingBox())!;
    const secondBox = (await second.boundingBox())!;
    await page.mouse.move(secondBox.x + secondBox.width / 2, Math.max(view.y + 10, secondBox.y + 10));
    await capture(page, `${format}-second-page-hover`, info);
    await expect(second.locator('[data-reader-page-label]')).toBeVisible();
    await expect(second.locator('[data-reader-page-label]')).toHaveText(`${format === 'epub' ? 'Section' : 'Page'} 2 of 5`);
    await expect(first.locator('[data-reader-page-label]')).toBeHidden();
    const during = await geometry(reader.viewport, format);
    await page.mouse.move(view.x + view.width / 2, view.y + 10);
    await expect(first.locator('[data-reader-page-label]')).toBeVisible();
    await expect(first.locator('[data-reader-page-label]')).toHaveText(`${format === 'epub' ? 'Section' : 'Page'} 1 of 5`);
    await page.mouse.move(0, 0);
    expect(await content()).toEqual(original);
    expect(await geometry(reader.viewport, format)).toEqual(during);
    await first.focus();
    await expect(first.locator('[data-reader-page-label]')).toBeVisible();
    expect(await first.locator('[data-reader-page-label]').evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
    await page.getByLabel('Reading mode').selectOption('paged');
    await expect(reader.entries).toHaveCount(1);
    await expect(reader.labels).toHaveCount(1);
    if (format === 'epub') await reader.direct.selectOption('4');
    else { await reader.direct.fill('5'); await reader.direct.press('Enter'); }
    await expect(reader.labels).toHaveText(`${format === 'epub' ? 'Section' : 'Page'} 5 of 5`);
    await reader.entries.first().focus();
    await capture(page, `${format}-hovered-label`, info);
    await fs.writeFile(info.outputPath(`${format}-label-observation.json`), JSON.stringify({ before, during, original, label: await reader.labels.textContent() }, null, 2));
  });
});

for (const format of ['cbz', 'pdf', 'epub'] as const) {
  test(`${format} fullscreen hover keeps pending content work and real failure warnings visible`, async ({ page, app }, info) => {
    let release!: () => void, held = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(format === 'pdf' ? '**/content?*' : '**/readers/*/resources/*', async route => {
      if (route.request().method() === 'GET') {
        held++;
        await gate;
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"ABS_UNAVAILABLE","error":"Generated reader resource unavailable"}' });
      } else await route.continue();
    });
    try {
      await signIn(page, app);
      const card = page.getByRole('link', { name: format === 'cbz' ? 'Open The Paper Observatory' : 'Open A Tale in Two Formats', exact: true });
      await expect(card.getByRole('img')).toHaveCount(0); await card.click();
      if (format === 'pdf') await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
      await page.getByRole('link', { name: 'Read', exact: true }).click();
      await expect.poll(() => held).toBe(1);
      await page.getByRole('button', { name: 'Full screen', exact: true }).click();
      const reader = ui(page, format);
      await revealReaderControls(page); await hideReaderControls(page, reader.viewport);
      await revealReaderControls(page); await hideReaderControls(page, reader.viewport);
      expect(held).toBe(1);
      release();
      await expect(page.getByRole('alert').first()).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'Press Esc to exit fullscreen.' })).toBeHidden({ timeout: 6000 });
      await expect(page.getByRole('alert').first()).toBeVisible();
      await capture(page, `${format}-fullscreen-resource-error`, info);
      await page.keyboard.press('Escape');
    } finally { release(); }
  });

  test(`${format} all four fullscreen corners reveal overlay controls without moving the anchor`, async ({ page, app }, info) => {
    await signIn(page, app); await open(page, format);
    const reader = ui(page, format);
    if (format === 'cbz') {
      await reader.option.click(); await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('300'); await reader.option.click();
    }
    await page.getByRole('button', { name: 'Full screen', exact: true }).click();
    const hint = page.getByRole('status').filter({ hasText: 'Press Esc to exit fullscreen. Move your mouse to any corner to show controls.' });
    await capture(page, `${format}-fullscreen-entry`, info);
    await expect.soft(page.getByRole('button', { name: 'Exit full screen', exact: true })).toBeHidden({ timeout: 1000 });
    await expect(hint).toBeVisible({ timeout: 1000 });
    const hintStarted = Date.now();
    await expect(hint).toBeHidden({ timeout: 6000 });
    const hintRemainingMs = Date.now() - hintStarted;
    expect(hintRemainingMs).toBeGreaterThan(2800);
    await reader.viewport.evaluate((element, format) => {
      const first = element.querySelector<HTMLElement>('[data-page="1"]');
      element.scrollTop = format === 'epub' ? 800 : format === 'pdf' ? first!.offsetTop + first!.offsetHeight * 0.2 :
        Math.max(0, first!.offsetHeight - element.clientHeight) * 0.4;
    }, format);
    await page.waitForTimeout(450);
    const before = await geometry(reader.viewport, format);
    const drawable = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const observations: object[] = [];
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const point = await corner(page, x, y);
      await page.mouse.move(point.x, point.y);
      await expect(page.getByLabel('Reading mode')).toBeVisible();
      await expect(reader.direct).toBeVisible(); await expect(reader.option).toBeVisible();
      await expect(reader.turns).toHaveCount(0);
      const controlBox = (await reader.option.boundingBox())!;
      await page.mouse.move(controlBox.x + controlBox.width / 2, controlBox.y + controlBox.height / 2);
      await reader.option.click();
      const focusState = async () => ({
        parent: await page.evaluate(() => ({ active: document.activeElement?.tagName, focused: document.hasFocus() })),
        control: await reader.option.evaluate(element => ({ active: element.ownerDocument.activeElement?.tagName,
          id: element.ownerDocument.activeElement?.id, focused: element.ownerDocument.hasFocus(),
          within: element.parentElement?.closest('[data-reader-chrome]')?.matches(':focus-within') })),
      });
      const menuOpened = await focusState();
      await away(page, reader.viewport);
      await page.waitForTimeout(1000);
      await fs.writeFile(info.outputPath('menu-focus.json'), JSON.stringify({ corner: [x, y], menuOpened, afterLeave: await focusState() }, null, 2));
      await expect(reader.option).toBeVisible();
      expect(await geometry(reader.viewport, format)).toEqual(before);
      observations.push({ corner: [x, y], geometry: await geometry(reader.viewport, format) });
      if (format === 'cbz') await reader.option.click();
      else await reader.option.press('Tab');
      await away(page, reader.viewport);
      await reader.viewport.focus();
      await expect(page.getByLabel('Reading mode')).toBeHidden({ timeout: 2500 });
      expect(await geometry(reader.viewport, format)).toEqual(before);
    }
    const point = await corner(page, 0, 1);
    await page.mouse.move(point.x, point.y);
    await expect(reader.direct).toBeVisible();
    await capture(page, `${format}-corner-controls`, info);
    await page.getByLabel('Reading mode').selectOption('paged');
    await expect(reader.turns).toHaveCount(2);
    await page.getByLabel('Reading mode').selectOption('continuous');
    await expect(reader.turns).toHaveCount(0);
    await away(page, reader.viewport); await reader.viewport.focus();
    await expect(page.getByLabel('Reading mode')).toBeHidden({ timeout: 2500 });
    // Tab out of the reading region must reveal focusable chrome, including in the sandboxed frame.
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Reading mode')).toBeVisible();
    await reader.direct.focus();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toBeFocused();
    const itemId = format === 'cbz' ? 'manga' : 'dual';
    const item = parseBookItem(await (await page.request.get(`${app.origin}/api/books/items/${itemId}`)).json());
    const file = item.files.find(file => file.extension === format)!;
    const saved = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/progress/ebook') && response.status() === 200);
    await page.getByRole('link', { name: 'Back to book', exact: true }).click(); await saved;
    const locator = parseProgress((await (await page.request.get(`${app.origin}/api/books/items/${itemId}/progress/ebook?editionId=${file.fileId}`)).json()).progress).locator;
    if (locator.kind === 'pdf') expect(locator.offset).toBeCloseTo(0.2, 2);
    if (locator.kind === 'cbz') expect(locator.offset).toBeCloseTo(0.4, 2);
    if (locator.kind === 'epub') expect(locator.textOffset).toBeGreaterThan(100);
    if (format === 'pdf') await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await page.getByRole('button', { name: 'Resume saved position' }).click();
    await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.fullscreenElement !== null)).toBe(false);
    if (format === 'cbz') {
      await reader.option.click(); await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('300'); await reader.option.click();
    }
    await expect.poll(() => reader.viewport.evaluate((element, locator) => {
      if (locator.kind === 'pdf' || locator.kind === 'cbz') {
        const entry = element.querySelector<HTMLElement>('[data-page="1"]');
        if (!entry) return 999;
        return Math.abs(element.scrollTop - entry.offsetTop -
          (locator.kind === 'pdf' ? entry.offsetHeight : Math.max(0, entry.offsetHeight - element.clientHeight)) * locator.offset);
      }
      if (locator.kind !== 'epub') return 999;
      const section = document.getElementById('book')!.shadowRoot!.querySelector<HTMLElement>('[data-section="0"]');
      if (!section) return 999;
      const walker = document.createTreeWalker(section.shadowRoot!.querySelector('article')!, NodeFilter.SHOW_TEXT);
      let remaining = locator.textOffset, node: Node | null;
      while ((node = walker.nextNode())) {
        if (node.parentElement?.closest('style,script')) continue;
        if (remaining <= node.textContent!.length) {
          const range = document.createRange(); range.setStart(node, remaining); range.setEnd(node, Math.min(node.textContent!.length, remaining + 1));
          return Math.abs(range.getBoundingClientRect().top - element.getBoundingClientRect().top);
        }
        remaining -= node.textContent!.length;
      }
      return 999;
    }, locator)).toBeLessThanOrEqual(2);
    await page.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect(hint).toBeVisible();
    await page.keyboard.press('Escape');
    await fs.writeFile(info.outputPath(`${format}-corner-observations.json`), JSON.stringify({ observations, locator, drawable, hintRemainingMs }, null, 2));
  });

  test(`${format} touch corners reveal once without turning and fallback hint is transient`, async ({ page, app, browserName }, info) => {
    await page.addInitScript(() => { Element.prototype.requestFullscreen = () => Promise.reject(new DOMException('Fixture denied', 'NotAllowedError')); });
    await signIn(page, app); await open(page, format);
    const reader = ui(page, format);
    await page.getByRole('button', { name: 'Full screen', exact: true }).tap();
    await expect(page.getByRole('status').filter({ hasText: 'Tap any corner' })).toBeVisible({ timeout: 1500 });
    await expect(page.getByRole('status').filter({ hasText: 'Tap any corner' }).getByText('Viewport-only view', { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Tap any corner' })).toBeHidden({ timeout: 6000 });
    const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined;
    const before = await geometry(reader.viewport, format);
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const point = await corner(page, x, y);
      if (cdp) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 0, ...point }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else await page.touchscreen.tap(point.x, point.y);
      await expect(page.getByLabel('Reading mode')).toBeVisible();
      await expect(reader.direct).toBeVisible(); await expect(reader.turns).toHaveCount(0);
      expect(await geometry(reader.viewport, format)).toEqual(before);
      await expect(page.getByLabel('Reading mode')).toBeHidden({ timeout: 3000 });
    }
    const point = await corner(page, 0, 1);
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 0, ...point }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 0, x: point.x, y: point.y - 100 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(page.getByLabel('Reading mode')).toBeHidden();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 0, ...point }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 0, ...point }, { id: 1, x: point.x + 100, y: point.y - 100 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(page.getByLabel('Reading mode')).toBeHidden();
    } else {
      const cornerButton = page.getByRole('button', { name: 'Show reader controls (bottom left)', exact: true });
      await cornerButton.dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: point.x, clientY: point.y });
      await cornerButton.dispatchEvent('pointermove', { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: point.x, clientY: point.y - 100 });
      await cornerButton.dispatchEvent('click', { detail: 1 });
      await expect(page.getByLabel('Reading mode')).toBeHidden();
    }
    // A cancelled corner tap must not become a page turn. Native vertical pan
    // remains allowed, so its scroll offset is not expected to stay fixed.
    if (format === 'epub') await expect(page.frameLocator('iframe').getByRole('status', { includeHidden: true })).toContainText('Section 1 of');
    else await expect(reader.direct).toHaveValue('1');
    await cdp?.detach();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toBeFocused();
    await fs.writeFile(info.outputPath(`${format}-corner-touch.json`), JSON.stringify({ before, browserName,
      input: cdp ? 'trusted Chromium CDP touch; not physical hardware' : 'Playwright touchscreen input', native: false }, null, 2));
  });
}
