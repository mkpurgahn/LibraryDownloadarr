import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, signIn, capture, revealReaderControls, hideReaderControls } from './harness';
import { parseProgress } from '../../src/books/types';

test.use({ cbzFixtures: true, hasTouch: true });

type Screen = 'normal' | 'native' | 'fallback';
const viewport = (page: Page) => page.getByRole('region', { name: 'Comic page', exact: true });
const entry = (page: Page, number: number) => viewport(page).locator(`[data-page="${number}"]`);

async function decoded(page: Page, number: number) {
  const image = entry(page, number).getByRole('img');
  await expect(image).toBeVisible();
  await expect(viewport(page)).toHaveAttribute('aria-busy', 'false');
  const { comicPanel } = await import('../../../backend/dist/books/proof/cbzFixture.js');
  const expected = createHash('sha256').update(comicPanel(number === 3 ? 10 : number)).digest('hex');
  await expect.poll(() => image.evaluate(async element => {
    const image = element as HTMLImageElement;
    if (!image.naturalWidth || !image.complete) return 'not decoded';
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await (await fetch(image.src)).arrayBuffer()))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
  })).toBe(expected);
}

async function save(page: Page) {
  const response = page.waitForResponse(response => response.request().method() === 'PUT' &&
    response.url().endsWith('/progress/ebook') && response.status() === 200 &&
    response.request().postDataJSON().op === 'save');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  return parseProgress((await (await response).json()).progress).locator;
}

async function settled(page: Page) {
  await expect(viewport(page)).toHaveAttribute('aria-busy', 'false');
  // Include the 400ms scroll-save debounce, not only the immediate click counter.
  await page.waitForTimeout(650);
  return viewport(page).evaluate(element => {
    const box = element.getBoundingClientRect();
    const entries = [...element.querySelectorAll<HTMLElement>('[data-page]')];
    const current = entries.find(entry => {
      const bounds = entry.getBoundingClientRect();
      return bounds.top <= box.top + 1 && bounds.bottom > box.top + 1;
    })!;
    const image = current.querySelector<HTMLImageElement>('img')!;
    return {
      currentPage: Number(current.dataset.page), image: image.alt, decoded: image.complete && image.naturalWidth > 0,
      scrollTop: element.scrollTop, scrollLeft: element.scrollLeft,
      viewport: { x: box.x, y: box.y, width: box.width, height: box.height },
      currentTop: current.getBoundingClientRect().top, currentHeight: current.offsetHeight,
      retainedPages: entries.map(entry => Number(entry.dataset.page)),
    };
  });
}

async function imagePoint(page: Page, number: number, side: 'left' | 'right') {
  const view = (await viewport(page).boundingBox())!, image = (await entry(page, number).getByRole('img').boundingBox())!;
  const left = Math.max(view.x, image.x), right = Math.min(view.x + view.width, image.x + image.width);
  const top = Math.max(view.y, image.y), bottom = Math.min(view.y + view.height, image.y + image.height);
  return { x: left + (right - left) * (side === 'left' ? 0.1 : 0.9), y: (top + bottom) / 2 };
}

async function open(page: Page, screen: Screen) {
  if (screen === 'fallback') await page.evaluate(() => {
    Element.prototype.requestFullscreen = () => Promise.reject(new DOMException('Generated fallback', 'NotAllowedError'));
  });
  const card = page.getByRole('link', { name: 'Open The Paper Observatory', exact: true });
  await expect(card.getByRole('img')).toHaveCount(0); await card.click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await decoded(page, 1);
  await expect(page.getByLabel('Reading mode')).toHaveValue('continuous');
  await expect(viewport(page).getByRole('img')).toHaveCount(2);
  if (screen !== 'normal') {
    await page.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect(page.locator('[data-reader-fullscreen]')).not.toHaveAttribute('data-reader-fullscreen', 'normal');
    await expect(page.getByRole('button', { name: 'Exit full screen', exact: true })).toBeHidden({ timeout: 1000 });
  }
  await viewport(page).evaluate(element => {
    const first = element.querySelector<HTMLElement>('[data-page="1"]')!;
    element.scrollTop = Math.max(0, first.offsetHeight - element.clientHeight) * 0.2;
  });
  await settled(page);
}

for (const screen of ['normal', 'native', 'fallback'] as const) for (const side of ['left', 'right'] as const) {
  test(`Continuous ${screen} ${side} image clicks and taps preserve the settled reading position`, async ({ page, app, browserName }, info) => {
    await signIn(page, app); await open(page, screen);
    const actualScreen = await page.locator('[data-reader-fullscreen]').getAttribute('data-reader-fullscreen');
    if (screen === 'native' && browserName === 'chromium') expect(actualScreen).toBe('native');
    if (screen === 'fallback') expect(actualScreen).toBe('viewport');
    const originalUrl = page.url(), originalLocator = await save(page), observations: object[] = [];
    for (const input of ['mouse', 'touch'] as const) {
      const before = await settled(page), beforeSaved = await save(page);
      expect(before.currentPage).toBe(1); expect(before.decoded).toBe(true);
      expect(beforeSaved).toMatchObject({ kind: 'cbz', page: 1 });
      const point = await imagePoint(page, 1, side);
      const target = await page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y)!;
        return { tag: element.tagName, alt: element.getAttribute('alt') };
      }, point);
      expect(target).toEqual({ tag: 'IMG', alt: 'Comic page 1 of 3' });
      await page.mouse.move(point.x, point.y);
      const cursorBefore = await entry(page, 1).getByRole('img').evaluate(element => getComputedStyle(element).cursor);
      await capture(page, `${input}-image-before`, info);
      if (input === 'mouse') await page.mouse.click(point.x, point.y);
      else await page.touchscreen.tap(point.x, point.y);
      const after = await settled(page), afterSaved = await save(page);
      await capture(page, `${input}-image-after`, info);
      observations.push({ screen, actualScreen, side, input, point, target, cursorBefore, before, beforeSaved, after, afterSaved });
      await fs.writeFile(info.outputPath('continuous-image-actions.json'), JSON.stringify(observations, null, 2));
      expect(after).toEqual(before);
      expect(afterSaved).toEqual(beforeSaved);
      expect(cursorBefore).not.toBe('pointer');
      await decoded(page, 1);
      await expect(entry(page, 1).locator('[data-reader-page-label]')).toHaveText('Page 1 of 3');
      await expect(page).toHaveURL(originalUrl);
    }
    if (screen !== 'normal') await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Back to book', exact: true }).click();
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
    await decoded(page, 1);
    expect(await save(page)).toEqual(originalLocator);
  });
}

test('Mode cycles clear the Paged cursor and stale clicks while preserving Paged image and gutter actions', async ({ page, app }, info) => {
  await signIn(page, app); await open(page, 'normal');
  const view = viewport(page), mode = page.getByLabel('Reading mode');
  const observations: object[] = [];
  for (const fullscreen of [false, true]) {
    if (fullscreen) {
      await page.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new DOMException('Fixture denied', 'NotAllowedError')); });
      await page.getByRole('button', { name: 'Full screen', exact: true }).click();
      await expect(page.locator('[data-reader-fullscreen]')).toHaveAttribute('data-reader-fullscreen', 'viewport');
      await revealReaderControls(page);
    }
    for (let cycle = 0; cycle < 2; cycle++) {
      await mode.selectOption('paged');
      await expect(view.getByRole('img')).toHaveCount(1);
      const options = page.getByRole('button', { name: 'View options' });
      await options.click(); await page.getByRole('combobox', { name: 'Page fit', exact: true }).selectOption('page'); await options.click();
      if (fullscreen) await hideReaderControls(page, view);
      let point = await imagePoint(page, 1, 'right');
      if (fullscreen) {
        const image = (await entry(page, 1).getByRole('img').boundingBox())!, bounds = (await view.boundingBox())!;
        expect(image.width).toBeLessThan(bounds.width * 0.75);
        point = { x: (image.x + image.width + bounds.x + bounds.width) / 2, y: point.y };
      }
      await page.mouse.move(point.x, point.y);
      await expect(view).toHaveCSS('cursor', 'pointer');
      await page.mouse.click(point.x, point.y); await decoded(page, 2);
      expect(await save(page)).toMatchObject({ kind: 'cbz', page: 2 });
      const left = await imagePoint(page, 2, 'left');
      await page.touchscreen.tap(left.x, left.y); await decoded(page, 1);
      if (fullscreen) await revealReaderControls(page);
      const armedPoint = await imagePoint(page, 1, 'right');
      await page.mouse.move(armedPoint.x, armedPoint.y);
      await expect(view).toHaveCSS('cursor', 'pointer');
      const event = { pointerId: 41, pointerType: 'mouse', isPrimary: true, button: 0,
        clientX: armedPoint.x, clientY: armedPoint.y };
      const armedAt = await page.evaluate(() => performance.now());
      await entry(page, 1).getByRole('img').dispatchEvent('pointerdown', event);
      await mode.selectOption('continuous');
      await expect(view).not.toHaveCSS('cursor', 'pointer');
      await entry(page, 1).getByRole('img').dispatchEvent('pointerup', event);
      await entry(page, 1).getByRole('img').dispatchEvent('click', { ...event, detail: 1 });
      const completionMs = await page.evaluate(() => performance.now()) - armedAt;
      expect(completionMs).toBeLessThan(500);
      if (fullscreen) await hideReaderControls(page, view);
      const before = await settled(page);
      expect(before.currentPage).toBe(1);
      expect(await save(page)).toMatchObject({ kind: 'cbz', page: 1 });
      const currentPoint = await imagePoint(page, 1, 'right');
      await page.mouse.move(currentPoint.x, currentPoint.y);
      await expect(entry(page, 1).getByRole('img')).not.toHaveCSS('cursor', 'pointer');
      await expect(entry(page, 1).locator('[data-reader-page-label]')).toBeVisible();
      await page.mouse.click(currentPoint.x, currentPoint.y); await page.touchscreen.tap(currentPoint.x, currentPoint.y);
      const after = await settled(page);
      expect(after).toEqual(before);
      observations.push({ fullscreen, cycle, before, after, saved: await save(page), completionMs, staleCompletionIgnored: true });
      if (fullscreen) await revealReaderControls(page);
    }
    if (fullscreen) {
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toBeFocused();
    }
  }
  await fs.writeFile(info.outputPath('mode-cycle-actions.json'), JSON.stringify(observations, null, 2));
});

test('Continuous scrolling, deliberate swipe, keyboard, Go, selection and corners retain their separate actions', async ({ page, app, browserName }, info) => {
  await signIn(page, app); await open(page, 'fallback');
  const view = viewport(page);
  const original = await settled(page);
  const box = (await view.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const wheelSteps: object[] = [];
  // Firefox caps a large wheel delta, so cross the boundary with bounded real scroll input.
  for (let step = 0; step < 8 && await page.getByLabel('Page number').inputValue() === '1'; step++) {
    const before = await view.evaluate(element => element.scrollTop);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => view.evaluate(element => element.scrollTop)).toBeGreaterThan(before);
    wheelSteps.push(await settled(page));
  }
  await fs.writeFile(info.outputPath('continuous-wheel-observation.json'), JSON.stringify({ original, wheelSteps }, null, 2));
  await expect(page.getByLabel('Page number')).toHaveValue('2');
  await decoded(page, 2);
  const scrolled = await settled(page), scrollSaved = await save(page);
  expect(scrolled.currentPage).toBe(2); expect(scrollSaved).toMatchObject({ kind: 'cbz', page: 2 });
  expect(scrolled.scrollTop).toBeGreaterThan(original.scrollTop);
  expect(scrolled.retainedPages.length).toBeLessThanOrEqual(3);
  const left = await imagePoint(page, 2, 'left'), right = await imagePoint(page, 2, 'right');
  const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined;
  try {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, ...right }] });
      for (let step = 1; step <= 5; step++) await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ id: 1, x: right.x + (left.x - right.x) * step / 5, y: right.y }],
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await view.dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: right.x, clientY: right.y }] });
      await view.dispatchEvent('touchend', { touches: [], changedTouches: [{ identifier: 1, clientX: left.x, clientY: right.y }] });
    }
    await expect(page.getByLabel('Page number')).toHaveValue('3'); await decoded(page, 3);
    expect(await save(page)).toMatchObject({ kind: 'cbz', page: 3 });
    const swipePoint = await imagePoint(page, 3, 'right'), beforeCompatibility = await settled(page);
    await entry(page, 3).getByRole('img').dispatchEvent('click', {
      detail: 1, button: 0, clientX: swipePoint.x, clientY: swipePoint.y,
    });
    expect(await settled(page)).toEqual(beforeCompatibility);
    await view.focus(); await page.keyboard.press('ArrowLeft');
    await expect(page.getByLabel('Page number')).toHaveValue('2'); await decoded(page, 2);
    await revealReaderControls(page);
    await page.getByLabel('Page number').fill('1'); await page.getByRole('button', { name: 'Go to page' }).click();
    await decoded(page, 1); expect(await save(page)).toMatchObject({ kind: 'cbz', page: 1 });
    await page.getByRole('button', { name: 'View options' }).click();
    await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('300');
    await page.getByRole('button', { name: 'View options' }).click();
    await hideReaderControls(page, view);
    await expect.poll(() => view.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    const panBefore = await settled(page);
    await page.mouse.wheel(100, 120);
    await expect.poll(() => view.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    const panAfter = await settled(page);
    expect(panAfter.currentPage).toBe(1); expect(panAfter.scrollLeft).toBeGreaterThan(panBefore.scrollLeft);
    const panSaved = await save(page);
    expect(panSaved).toMatchObject({ kind: 'cbz', page: 1 });
    if (panSaved.kind !== 'cbz') throw new Error('Expected comic locator');
    expect(panSaved.horizontal).toBeGreaterThan(0);
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      await page.mouse.click(x ? size.width - 10 : 10, y ? size.height - 10 : 10);
      await expect(page.getByLabel('Reading mode')).toBeVisible();
      await expect(page.getByRole('button', { name: 'View options' })).toBeVisible();
      await expect(page.getByRole('button', { name: /^(Previous|Next) page$/ })).toHaveCount(0);
      expect(await save(page)).toEqual(panSaved);
      await hideReaderControls(page, view);
    }
    await revealReaderControls(page);
    const heading = page.getByRole('heading', { name: 'The Paper Observatory', exact: true });
    await heading.evaluate(element => {
      const selection = getSelection()!, text = element.firstChild!;
      selection.setBaseAndExtent(text, 0, text, text.textContent!.length);
    });
    expect(await page.evaluate(() => getSelection()!.toString())).toBe('The Paper Observatory');
    const point = await imagePoint(page, 1, 'left');
    await page.mouse.move(point.x, point.y);
    await expect(entry(page, 1).locator('[data-reader-page-label]')).toBeVisible();
    expect(await page.evaluate(() => getSelection()!.toString())).toBe('The Paper Observatory');
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toBeFocused();
    await page.getByRole('link', { name: 'Back to book', exact: true }).click();
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
    await decoded(page, 1);
    expect(await save(page)).toEqual(panSaved);
    await fs.writeFile(info.outputPath('continuous-explicit-actions.json'), JSON.stringify({
      original, scrolled, scrollSaved, swipePage: 3, keyboardPage: 2, directGoPage: 1, panBefore, panAfter, panSaved,
      corners: 4, selectionPreservedDuringHover: true, durableReopen: await save(page),
      swipeInput: cdp ? 'trusted Chromium CDP touch' : 'synthetic TouchEvent handler',
    }, null, 2));
  } finally { await cdp?.detach(); }
});
