import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { CDPSession, Locator, Page } from '@playwright/test';
import { test, expect, signIn, capture, revealReaderControls, hideReaderControls } from './harness';
import { parseBookItem, parseProgress } from '../../src/books/types';

test.use({ cbzFixtures: true, shortReaderFixtures: true, hasTouch: true });

const viewport = (page: Page) => page.getByRole('region', { name: 'Comic page', exact: true });
const image = (page: Page) => viewport(page).getByRole('img');
async function panel(page: Page, number: number) {
  const current = page.getByRole('img', { name: `Comic page ${number} of 5`, exact: true });
  await expect(current).toBeVisible();
  await expect(viewport(page)).toHaveAttribute('aria-busy', 'false');
  const { comicPanel } = await import('../../../backend/dist/books/proof/cbzFixture.js');
  const digest = createHash('sha256').update(comicPanel(number, 1, number === 2 ? 960 : 480, number === 2 ? 180 : 720)).digest('hex');
  expect(await current.evaluate(async element => {
    const bytes = await (await fetch((element as HTMLImageElement).src)).arrayBuffer();
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  })).toBe(digest);
}
async function saved(page: Page) {
  const item = parseBookItem(await (await page.request.get(new URL('/api/books/items/manga', page.url()).href)).json());
  const file = item.files.find(file => file.basename === 'Observatory - chapter A.cbz')!;
  const read = async () => parseProgress((await (await page.request.get(new URL(
    `/api/books/items/manga/progress/ebook?editionId=${file.fileId}`, page.url()).href)).json()).progress).locator;
  return read;
}
async function open(page: Page, fallback = false) {
  if (fallback) await page.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new DOMException('Fixture denied', 'NotAllowedError')); });
  const card = page.getByRole('link', { name: 'Open The Paper Observatory', exact: true });
  await expect(card.getByRole('img')).toHaveCount(0); await card.click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await panel(page, 1);
  await page.getByLabel('Reading mode').selectOption('paged');
  await option(page, 'Page fit', 'page');
}
async function option(page: Page, name: 'Page fit' | 'Zoom', value: string) {
  const view = page.getByRole('button', { name: 'View options', exact: true });
  if (await view.getAttribute('aria-expanded') === 'false') await view.click();
  await page.getByRole('combobox', { name, exact: true }).selectOption(value);
  await view.click();
}
async function enter(page: Page) {
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect(page.locator('[data-reader-fullscreen]')).not.toHaveAttribute('data-reader-fullscreen', 'normal');
  await expect(page.getByRole('button', { name: 'Exit full screen', exact: true })).toBeHidden({ timeout: 1000 });
}
async function bounds(page: Page) {
  return viewport(page).evaluate(element => {
    const rect = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return { view: rect(element), image: rect(element.querySelector('img')!), screen: document.querySelector('main')!.getAttribute('data-reader-fullscreen') };
  });
}
async function point(page: Page, side: 'left' | 'right' | 'center', area: 'gutter' | 'image' = 'gutter') {
  const boxes = await bounds(page), v = boxes.view, i = boxes.image;
  const left = Math.max(v.x, i.x), right = Math.min(v.x + v.width, i.x + i.width);
  const top = Math.max(v.y, i.y), bottom = Math.min(v.y + v.height, i.y + i.height);
  const x = side === 'center' ? (left + right) / 2 : area === 'image'
    ? left + (right - left) * (side === 'left' ? 0.1 : 0.9)
    : side === 'left' ? (v.x + left) / 2 : (right + v.x + v.width) / 2;
  return { x, y: (top + bottom) / 2 };
}

for (const fallback of [false, true]) for (const side of ['left', 'right'] as const) {
  test(`CBZ ${fallback ? 'fallback' : 'native'} fullscreen ${side} gutter turns the decoded and durable page`, async ({ page, app, browserName }, info) => {
    await signIn(page, app); await open(page, fallback);
    await enter(page);
    const before = await bounds(page);
    if (!fallback && browserName === 'chromium') expect(before.screen).toBe('native');
    if (fallback) expect(before.screen).toBe('viewport');
    expect(before.image.width).toBeLessThan(before.view.width * 0.75);
    const target = await point(page, side);
    const hit = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y)!;
      return { tag: target.tagName, insideReadingViewport: Boolean(target.closest('[aria-label="Comic page"]')),
        image: target instanceof HTMLImageElement };
    }, target);
    expect(hit).toMatchObject({ insideReadingViewport: true, image: false });
    await page.mouse.move(target.x, target.y);
    await capture(page, `${side}-gutter-before-click`, info);
    await page.mouse.click(target.x, target.y);
    const expected = side === 'left' ? 5 : 2;
    await capture(page, `${side}-gutter-after-click`, info);
    await fs.writeFile(info.outputPath('gutter-observation.json'), JSON.stringify({
      side, fallback, before, target, hit, expected, actual: await image(page).getAttribute('alt'),
    }, null, 2));
    await panel(page, expected);
    const progress = await saved(page);
    await expect.poll(progress).toMatchObject({ kind: 'cbz', page: expected, offset: 0, horizontal: 0 });
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Back to book', exact: true }).click();
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
    await panel(page, expected);
    expect(await progress()).toMatchObject({ kind: 'cbz', page: expected, offset: 0, horizontal: 0 });
  });
}

test('CBZ gutters preserve center, image quarters, corners and non-fullscreen mode boundaries', async ({ page, app }, info) => {
  await signIn(page, app); await open(page, true);
  for (const side of ['left', 'right'] as const) {
    const target = await point(page, side); await page.mouse.click(target.x, target.y);
    await panel(page, 1);
  }
  await enter(page);
  const center = await point(page, 'center');
  await page.mouse.click(center.x, center.y); await panel(page, 1);
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.mouse.click(x ? size.width - 10 : 10, y ? size.height - 10 : 10);
    await expect(page.getByLabel('Reading mode')).toBeVisible();
    await expect(page.getByRole('button', { name: 'View options' })).toBeVisible();
    await panel(page, 1);
    await hideReaderControls(page, viewport(page));
  }
  for (const [side, expected] of [['right', 2], ['left', 1]] as const) {
    const edge = await point(page, side, 'image'); await page.mouse.click(edge.x, edge.y); await panel(page, expected);
  }
  for (let index = 0; index < 2; index++) {
    await revealReaderControls(page);
    await page.getByLabel('Reading mode').selectOption('continuous');
    await hideReaderControls(page, viewport(page));
    for (const side of ['left', 'right'] as const) {
      const target = await point(page, side);
      await page.mouse.click(target.x, target.y);
      await expect(page.getByLabel('Page number')).toHaveValue('1');
    }
    await revealReaderControls(page); await page.getByLabel('Reading mode').selectOption('paged');
    await hideReaderControls(page, viewport(page)); await panel(page, 1);
    const left = await point(page, 'left'); await page.mouse.click(left.x, left.y); await panel(page, 5);
    const right = await point(page, 'right'); await page.mouse.click(right.x, right.y); await panel(page, 1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toBeFocused();
    const blank = await point(page, 'right'); await page.mouse.click(blank.x, blank.y); await panel(page, 1);
    await enter(page);
  }
  await fs.writeFile(info.outputPath('gutter-boundaries.json'), JSON.stringify({ corners: 4, modeCycles: 2, imageQuartersRetained: true, centerNeutral: true }));
});

test('CBZ fullscreen hit areas follow aspect ratio, fit and resized reading geometry', async ({ page, app }, info) => {
  await signIn(page, app); await open(page, true); await enter(page);
  const observations: object[] = [];
  for (const size of [{ width: 1280, height: 800 }, { width: 900, height: 900 }, { width: 500, height: 1000 }]) {
    await page.setViewportSize(size);
    await expect.poll(() => viewport(page).evaluate(element => element.getBoundingClientRect().width)).toBe(size.width);
    for (const fit of ['page', 'width']) {
      await revealReaderControls(page); await option(page, 'Page fit', fit);
      await hideReaderControls(page, viewport(page));
      const right = await point(page, 'right', 'image');
      await page.mouse.click(right.x, right.y); await panel(page, 2);
      const landscape = await bounds(page);
      expect(landscape.image.width / landscape.image.height).toBeCloseTo(960 / 180, 1);
      const y = Math.min(landscape.view.y + landscape.view.height - 65, landscape.image.y + landscape.image.height + 65);
      expect(y).toBeGreaterThan(landscape.image.y + landscape.image.height);
      const neutral = { x: landscape.view.x + landscape.view.width / 2, y };
      await page.mouse.click(neutral.x, neutral.y); await panel(page, 2);
      const blank = { x: landscape.view.x + landscape.view.width * 0.9, y };
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, blank)).not.toBe('IMG');
      await page.mouse.click(blank.x, blank.y); await panel(page, 3);
      const left = await point(page, 'left', 'image');
      await page.mouse.click(left.x, left.y); await panel(page, 2);
      const back = await point(page, 'left', 'image');
      await page.mouse.click(back.x, back.y); await panel(page, 1);
      observations.push({ size, fit, landscape, blank, centerBlankNeutral: true, saved: await (await saved(page))() });
    }
  }
  await fs.writeFile(info.outputPath('gutter-geometry.json'), JSON.stringify(observations, null, 2));
});

test('CBZ fullscreen gutter clicks cancel on movement, wheel, selection, long press and presentation changes', async ({ page, app }, info) => {
  await signIn(page, app); await open(page, true); await enter(page);
  const view = viewport(page), target = await point(page, 'right');
  const cancelled: string[] = [];
  for (const cause of ['drag-return', 'leave-return', 'wheel', 'contextmenu', 'longpress'] as const) {
    await page.mouse.move(target.x, target.y); await page.mouse.down();
    if (cause === 'drag-return') {
      await page.mouse.move(target.x - 40, target.y + 20); await page.mouse.move(target.x, target.y);
    } else if (cause === 'leave-return') {
      await page.mouse.move(0, 0); await page.mouse.move(target.x, target.y);
    } else if (cause === 'wheel') await page.mouse.wheel(0, 100);
    else if (cause === 'contextmenu') await view.dispatchEvent('contextmenu');
    else await page.waitForTimeout(550);
    await page.mouse.up(); await panel(page, 1); cancelled.push(cause);
  }
  await page.mouse.click(target.x, target.y, { button: 'right' }); await panel(page, 1);
  await revealReaderControls(page);
  await page.getByRole('heading', { name: 'The Paper Observatory', exact: true }).evaluate(element => {
    const selection = getSelection()!, range = document.createRange(); range.selectNodeContents(element);
    selection.removeAllRanges(); selection.addRange(range);
  });
  await page.mouse.click(target.x, target.y); await panel(page, 1);
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await hideReaderControls(page, view);
  const stale = { pointerId: 71, isPrimary: true, pointerType: 'mouse', button: 0, clientX: target.x, clientY: target.y };
  const complete = async () => {
    await view.dispatchEvent('pointerup', stale);
    await view.dispatchEvent('click', { detail: 1, button: 0, clientX: target.x, clientY: target.y });
  };
  for (const change of ['mode-cycle', 'fullscreen-cycle', 'resize', 'fit-cycle', 'page-cycle']) {
    await view.dispatchEvent('pointerdown', stale);
    if (change === 'fullscreen-cycle') {
      await page.keyboard.press('Escape'); await enter(page);
    } else if (change === 'resize') {
      const size = page.viewportSize()!;
      await page.setViewportSize({ ...size, height: size.height - 30 });
      await expect.poll(() => view.evaluate(element => element.clientHeight)).toBe(size.height - 30);
      await expect.poll(() => image(page).evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(size.height - 20);
      await page.setViewportSize(size);
    } else {
      await revealReaderControls(page);
      if (change === 'mode-cycle') {
        await page.getByLabel('Reading mode').selectOption('continuous');
        await page.getByLabel('Reading mode').selectOption('paged');
      } else if (change === 'fit-cycle') {
        await option(page, 'Page fit', 'width'); await option(page, 'Page fit', 'page');
      } else {
        await page.getByLabel('Page number').fill('3'); await page.getByRole('button', { name: 'Go to page' }).click();
        await panel(page, 3);
        await page.getByLabel('Page number').fill('1'); await page.getByRole('button', { name: 'Go to page' }).click();
      }
      await hideReaderControls(page, view);
    }
    await fs.writeFile(info.outputPath('gutter-stale-diagnostic.json'), JSON.stringify({
      change, phase: 'before-completion', alt: await image(page).getAttribute('alt'), cancelled,
    }, null, 2));
    await panel(page, 1);
    await complete();
    await fs.writeFile(info.outputPath('gutter-stale-diagnostic.json'), JSON.stringify({
      change, phase: 'after-completion', alt: await image(page).getAttribute('alt'), cancelled,
    }, null, 2));
    await panel(page, 1); cancelled.push(change);
  }
  await page.mouse.move(target.x, target.y);
  await expect(view).toHaveCSS('cursor', 'pointer');
  await page.keyboard.press('Escape');
  await expect(view).not.toHaveCSS('cursor', 'pointer');
  await enter(page);
  await page.mouse.click(target.x, target.y); await panel(page, 2);
  await expect.poll(await saved(page)).toMatchObject({ kind: 'cbz', page: 2 });
  await fs.writeFile(info.outputPath('gutter-cancellations.json'), JSON.stringify({ cancelled, cleanClickSaved: 2,
    staleCompletionCoverage: 'synthetic pointer events after real presentation transitions' }, null, 2));
});

type Contact = { id: number; x: number; y: number };
async function contact(session: CDPSession | undefined, target: Locator,
  type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: Contact[], changed: Contact[]) {
  if (session) await session.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  else {
    const values = (points: Contact[]) => points.map(point => ({ identifier: point.id, clientX: point.x, clientY: point.y }));
    await target.dispatchEvent(type.toLowerCase(), { touches: values(points), changedTouches: values(changed) });
  }
}
test('CBZ fullscreen gutter taps reject cross-target multicontact and post-swipe compatibility clicks', async ({ page, app, browserName }, info) => {
  await signIn(page, app); await open(page, true); await enter(page);
  const view = viewport(page);
  const session = browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined;
  try {
    for (const firstReleased of ['gutter', 'outside']) {
      await revealReaderControls(page);
      const outside = page.getByRole('heading', { name: 'The Paper Observatory', exact: true });
      const box = (await outside.boundingBox())!;
      const a = { ...await point(page, 'right'), id: firstReleased === 'gutter' ? 11 : 22 };
      const b = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: firstReleased === 'gutter' ? 22 : 11 };
      await contact(session, view, 'touchStart', [a], [a]);
      await contact(session, outside, 'touchStart', [a, b], [b]);
      if (session) await contact(session, view, 'touchEnd', [], [a, b]);
      else if (firstReleased === 'gutter') {
        await contact(session, view, 'touchEnd', [b], [a]); await contact(session, outside, 'touchEnd', [], [b]);
      } else {
        await contact(session, outside, 'touchEnd', [a], [b]); await contact(session, view, 'touchEnd', [], [a]);
      }
      await view.dispatchEvent('click', { detail: 1, button: 0, clientX: a.x, clientY: a.y });
      await panel(page, 1);
    }
    await hideReaderControls(page, view);
    const right = await point(page, 'right');
    await page.touchscreen.tap(right.x, right.y); await panel(page, 2);
    await expect.poll(await saved(page)).toMatchObject({ kind: 'cbz', page: 2 });
    const start = { ...await point(page, 'right', 'image'), id: 51 };
    const end = { ...await point(page, 'left', 'image'), id: 51 };
    await contact(session, view, 'touchStart', [start], [start]);
    for (let index = 1; index <= 5; index++) await contact(session, view, 'touchMove',
      [{ ...start, x: start.x + (end.x - start.x) * index / 5 }], [{ ...start, x: start.x + (end.x - start.x) * index / 5 }]);
    await contact(session, view, 'touchEnd', [], [end]); await panel(page, 3);
    const next = await point(page, 'right');
    await view.dispatchEvent('click', { detail: 1, button: 0, clientX: next.x, clientY: next.y }); await panel(page, 3);
    await expect.poll(await saved(page)).toMatchObject({ kind: 'cbz', page: 3 });
    await fs.writeFile(info.outputPath('gutter-touch.json'), JSON.stringify({ releaseOrders: 2, tapSavedPage: 2,
      swipeSavedPage: 3, compatibilityClickIgnored: true,
      input: session ? 'trusted native Chromium CDP touch' : 'synthetic touch cancellation/swipe; native Playwright touchscreen tap' }, null, 2));
  } finally { await session?.detach(); }
});

test('CBZ fullscreen gutters cannot turn during pending page work or after revocation', async ({ page, app }, info) => {
  await signIn(page, app); await open(page, true); await enter(page);
  let release!: () => void, held = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/readers/*/resources/*', async route => { held++; await gate; await route.continue(); });
  try {
    const target = await point(page, 'left');
    await page.mouse.click(target.x, target.y);
    await expect.poll(() => held).toBe(1);
    await expect(viewport(page)).toHaveAttribute('aria-busy', 'true');
    await page.mouse.click(target.x, target.y);
    await page.touchscreen.tap(target.x, target.y);
    expect(held).toBe(1);
    release(); await panel(page, 5);
    await expect.poll(await saved(page)).toMatchObject({ kind: 'cbz', page: 5 });
    await page.unroute('**/readers/*/resources/*');
    await viewport(page).dispatchEvent('pointerdown', { pointerId: 91, isPrimary: true, button: 0, pointerType: 'mouse',
      clientX: target.x, clientY: target.y });
    await page.evaluate(() => window.dispatchEvent(new Event('librarydownloadarr:books-changed')));
    await expect(image(page)).toHaveCount(0);
    await expect(page.getByRole('alert')).toContainText('Your Books session or configuration changed.');
    await viewport(page).dispatchEvent('pointerup', { pointerId: 91, isPrimary: true, button: 0, pointerType: 'mouse',
      clientX: target.x, clientY: target.y });
    await viewport(page).dispatchEvent('click', { detail: 1, button: 0, clientX: target.x, clientY: target.y });
    await expect(image(page)).toHaveCount(0);
    await fs.writeFile(info.outputPath('gutter-pending.json'), JSON.stringify({ heldRequests: held, savedPageAfterRelease: 5,
      revokedContentRemovedAndStaleCompletionIgnored: true }, null, 2));
  } finally { release(); }
});

test('CBZ a redundant resize notification cannot cancel a click on an already arranged viewport', async ({ page, app }) => {
  await page.addInitScript(() => {
    const NativeObserver = ResizeObserver;
    class ObservedResize extends NativeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          callback(entries, observer);
          if (entries.some(entry => entry.target.getAttribute('aria-label') === 'Comic page')) {
            Reflect.set(window, 'repeatGutterResize', () => callback(entries, observer));
          }
        });
      }
    }
    window.ResizeObserver = ObservedResize;
  });
  await signIn(page, app); await open(page, true); await enter(page);
  await expect.poll(() => page.evaluate(() => typeof Reflect.get(window, 'repeatGutterResize'))).toBe('function');
  const target = await point(page, 'right'), before = await bounds(page);
  await page.mouse.move(target.x, target.y); await page.mouse.down();
  await page.evaluate(() => Reflect.get(window, 'repeatGutterResize')());
  expect(await bounds(page)).toEqual(before);
  await page.mouse.up(); await panel(page, 2);
});
