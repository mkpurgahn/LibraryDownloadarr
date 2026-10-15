import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { CDPSession, Locator, Page, Route } from '@playwright/test';
import { test, expect, signIn, capture, originalDownload } from './harness';
import { parseReader } from '../../src/books/types';

test.use({ cbzFixtures: true, controlledReaderClock: true, reverseProxy: true });

async function openComic(page: Page) {
  const card = page.getByRole('link', { name: 'Open The Paper Observatory', exact: true });
  await card.scrollIntoViewIfNeeded();
  // The fixture's absent cover must not remove the pointer target during the click.
  await expect(card.getByRole('img')).toHaveCount(0);
  await card.click();
  await expect(page.getByLabel('Ebook original').locator('option')).toHaveCount(2);
}

async function expectPanel(page: Page, position: number, panel: number, chapter = 1, total = 3) {
  const image = page.getByRole('img', { name: `Comic page ${position} of ${total}`, exact: true });
  await expect(image).toBeVisible();
  await expect(page.getByRole('region', { name: 'Comic page', exact: true })).toHaveAttribute('aria-busy', 'false');
  const { comicPanel } = await import('../../../backend/dist/books/proof/cbzFixture.js');
  const expected = createHash('sha256').update(comicPanel(panel, chapter)).digest('hex');
  await expect.poll(() => image.evaluate(async element => {
    const image = element as HTMLImageElement;
    if (!image.complete || !image.naturalWidth) return 'not decoded';
    const source = image.src;
    let data: ArrayBuffer;
    try { data = await (await fetch(source)).arrayBuffer(); }
    catch (error) {
      if (!image.isConnected || image.src !== source) return 'image replaced during explicit resume';
      throw error;
    }
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
  })).toBe(expected);
}

async function expectFraction(viewport: Locator, axis: 'vertical' | 'horizontal', fraction: number) {
  await expect.poll(() => viewport.evaluate((element, axis) => axis === 'vertical'
    ? element.scrollTop / (element.scrollHeight - element.clientHeight)
    : element.scrollLeft / (element.scrollWidth - element.clientWidth), axis)).toBeCloseTo(fraction, 2);
}

async function pageEdge(page: Page, side: 'left' | 'right') {
  const image = (await page.getByRole('img', { name: /Comic page/ }).boundingBox())!;
  const viewport = (await page.getByRole('region', { name: 'Comic page', exact: true }).boundingBox())!;
  const left = Math.max(image.x, viewport.x);
  const right = Math.min(image.x + image.width, viewport.x + viewport.width);
  const top = Math.max(image.y, viewport.y);
  const bottom = Math.min(image.y + image.height, viewport.y + viewport.height);
  return { x: left + (right - left) * (side === 'left' ? 0.1 : 0.9), y: (top + bottom) / 2 };
}

async function setViewOption(page: Page, label: 'Page fit' | 'Zoom', value: string) {
  const options = page.getByRole('button', { name: 'View options', exact: true });
  if (await options.getAttribute('aria-expanded') === 'false') await options.click();
  await page.getByRole('combobox', { name: label, exact: true }).selectOption(value);
  if (label === 'Zoom') await expect.poll(() => page.getByRole('img', { name: /Comic page/ })
    .evaluate(element => element.getBoundingClientRect().width)).toBe(480 * Number(value) / 100);
  await options.click();
}

test('CBZ View has only fit and zoom and preserves page and bookmark', async ({ page, app }, info) => {
  await signIn(page, app);
  await openComic(page);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expectPanel(page, 1, 1);
  const view = page.getByRole('button', { name: 'View options', exact: true });
  const next = page.getByRole('button', { name: 'Next page', exact: true });
  const previous = page.getByRole('button', { name: 'Previous page', exact: true });
  await expect(next).toBeEnabled();
  await expect.poll(() => next.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
  await view.click();
  await capture(page, 'cbz-loop-view', info);
  await expect(page.getByRole('combobox', { name: 'Reading direction', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Reading options', exact: true }).getByRole('combobox')).toHaveCount(2);
  const initialSize = page.viewportSize()!;
  const geometry: object[] = [];
  for (const width of [320, initialSize.width]) {
    await page.setViewportSize({ ...initialSize, width });
    const options = (await page.getByRole('region', { name: 'Reading options', exact: true }).boundingBox())!;
    for (const control of await page.getByRole('region', { name: 'Reading options', exact: true }).getByRole('combobox').all()) {
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(options.x);
      expect(box.x + box.width).toBeLessThanOrEqual(options.x + options.width + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await page.getByRole('region', { name: 'Comic page', exact: true }).boundingBox())!.height).toBeGreaterThan(300);
    geometry.push({ width, controlsContained: true, minimumControlHeight: 44, documentOverflow: false });
  }
  await expect(page.getByText('Left: previous. Right: next. First and last pages connect within this original.', { exact: true })).toBeVisible();
  expect((await next.boundingBox())!.x).toBeGreaterThan((await previous.boundingBox())!.x);
  await expectPanel(page, 1, 1);
  expect(await savedComicPage(page)).toBe(1);
  await expect.poll(() => next.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
  await view.click();
  await setViewOption(page, 'Zoom', '300');
  const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
  await viewport.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.6;
    element.scrollLeft = (element.scrollWidth - element.clientWidth) * 0.6;
  });
  await view.click();
  for (let toggle = 0; toggle < 2; toggle++) {
    await view.click();
    await expectPanel(page, 1, 1);
    await expectFraction(viewport, 'vertical', 0.6);
    await expectFraction(viewport, 'horizontal', 0.6);
    expect(await savedComicPage(page)).toBe(1);
  }
  await page.getByRole('link', { name: 'Back to book' }).click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
  await expectPanel(page, 1, 1);
  await setViewOption(page, 'Zoom', '300');
  await expectFraction(viewport, 'vertical', 0.6);
  await expectFraction(viewport, 'horizontal', 0.6);
  await setViewOption(page, 'Page fit', 'page');
  const edge = await pageEdge(page, 'right');
  await page.mouse.click(edge.x, edge.y);
  await expectPanel(page, 2, 2);
  expect(await savedComicPage(page)).toBe(2);
  await view.click();
  expect((await next.boundingBox())!.x).toBeGreaterThan((await previous.boundingBox())!.x);
  await expectPanel(page, 2, 2);
  expect(await savedComicPage(page)).toBe(2);
  await fs.writeFile(info.outputPath('loop-view.json'), JSON.stringify({
    directionControlAbsent: true, viewPreservedPageAndBothFractions: true,
    savedReopenFractions: { vertical: 0.6, horizontal: 0.6 }, rightEdgeSavedPage: 2, geometry,
  }, null, 2));
});

type ComicContact = { id: number; x: number; y: number };
type ComicTouchEvent = {
  type: string; trusted: boolean; target: string; touches: number[];
  changed: Array<{ id: number; x: number; y: number }>;
};
async function comicTouch(session: CDPSession | undefined, target: Locator,
  type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', contacts: ComicContact[], changed: ComicContact[]) {
  if (session) {
    await session.send('Input.dispatchTouchEvent', { type, touchPoints: contacts });
  } else {
    const points = (values: ComicContact[]) => values.map(({ id, x, y }) => ({ identifier: id, clientX: x, clientY: y }));
    await target.dispatchEvent(type.toLowerCase(), { touches: points(contacts), changedTouches: points(changed) });
  }
}

async function savedComicPage(page: Page) {
  await expect(page.getByRole('region', { name: 'Comic page', exact: true })).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByText('Position saved', { exact: true })).toBeVisible();
  const saved = page.waitForResponse(response => response.request().method() === 'PUT' &&
    response.url().endsWith('/progress/ebook') && response.status() === 200 &&
    response.request().postDataJSON().op === 'save');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  return (await (await saved).json()).progress.locator.page as number;
}

for (const single of [false, true]) {
  test(`CBZ page arrows share rendered styles for ${single ? 'single-page disabled' : 'ready hover focus and loading'} states`, async ({ page, app }, info) => {
    if (single) await app.setCbz('single');
    await signIn(page, app);
    await openComic(page);
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await expectPanel(page, 1, 1, 1, single ? 1 : 3);
    const previous = page.getByRole('button', { name: 'Previous page', exact: true });
    const next = page.getByRole('button', { name: 'Next page', exact: true });
    const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
    const style = async (button: Locator) => {
      await button.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      await expect.poll(() => button.evaluate(element =>
        element.getAnimations().every(animation => animation.playState !== 'running'))).toBe(true);
      return button.evaluate(element => {
        const css = getComputedStyle(element);
        return { background: css.backgroundColor, image: css.backgroundImage, color: css.color,
          shadow: css.boxShadow, opacity: css.opacity, cursor: css.cursor,
          width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height };
      });
    };
    const observations: Record<string, unknown> = {};
    await page.mouse.move(0, 0); await viewport.focus();
    observations.ready = { previous: await style(previous), next: await style(next) };
    await capture(page, single ? 'cbz-arrows-single' : 'cbz-arrows-ready', info);
    await fs.writeFile(info.outputPath('arrow-styles.json'), JSON.stringify(observations, null, 2));
    const normal = await style(next);
    expect(await style(previous)).toEqual(normal);
    expect(normal).toMatchObject({ background: single ? 'rgb(45, 45, 45)' : 'rgb(67, 56, 202)',
      color: single ? 'rgb(209, 213, 219)' : 'rgb(255, 255, 255)', image: 'none',
      opacity: single ? '0.4' : '1', width: 44, height: 44 });
    if (single) {
      await expect(previous).toBeDisabled(); await expect(next).toBeDisabled();
      await previous.hover(); const previousHover = await style(previous);
      await next.hover(); expect(await style(next)).toEqual(previousHover);
      expect(previousHover).toMatchObject({ background: 'rgb(45, 45, 45)', cursor: 'not-allowed' });
      await expectPanel(page, 1, 1, 1, 1);
      expect(await savedComicPage(page)).toBe(1);
      observations.disabledHover = previousHover;
    } else {
      await expect(previous).toBeEnabled(); await expect(next).toBeEnabled();
      await previous.hover(); const previousHover = await style(previous);
      await next.hover(); const nextHover = await style(next);
      expect(previousHover).toEqual(nextHover);
      expect(nextHover.background).toBe('rgb(79, 70, 229)');
      await page.mouse.move(0, 0);
      await previous.focus(); await expect(previous).toBeFocused();
      const previousFocus = await style(previous);
      await next.focus(); await expect(next).toBeFocused();
      const nextFocus = await style(next);
      expect(previousFocus).toEqual(nextFocus);
      expect(nextFocus.shadow).toContain('rgb(165, 180, 252)');
      observations.hover = { previous: previousHover, next: nextHover };
      observations.focus = { previous: previousFocus, next: nextFocus };
      let held: Route | undefined;
      await page.route('**/readers/*/resources/*', route => { held = route; });
      await previous.click();
      await expect.poll(() => Boolean(held)).toBe(true);
      await expect(viewport).toHaveAttribute('aria-busy', 'true');
      await expect(previous).toBeDisabled(); await expect(next).toBeDisabled();
      await page.mouse.move(0, 0); await viewport.focus();
      const disabled = await style(next);
      expect(await style(previous)).toEqual(disabled);
      expect(disabled).toMatchObject({ background: 'rgb(45, 45, 45)', color: 'rgb(209, 213, 219)',
        opacity: '0.4', cursor: 'not-allowed', width: 44, height: 44 });
      observations.loading = disabled;
      await held!.continue(); await page.unroute('**/readers/*/resources/*');
      await expectPanel(page, 3, 10);
      expect(await savedComicPage(page)).toBe(3);
      await next.click(); await expectPanel(page, 1, 1);
      expect(await savedComicPage(page)).toBe(1);
      observations.actualWrapSavedPages = [3, 1];
    }
    await fs.writeFile(info.outputPath('arrow-styles.json'), JSON.stringify(observations, null, 2));
  });
}

async function swipeComic(page: Page, session: CDPSession | undefined, forward: boolean) {
  const image = page.getByRole('img', { name: /Comic page/ });
  const start = { ...await pageEdge(page, forward ? 'right' : 'left'), id: 61 };
  const end = { ...await pageEdge(page, forward ? 'left' : 'right'), id: 61 };
  await comicTouch(session, image, 'touchStart', [start], [start]);
  for (let step = 1; step <= 5; step++) {
    const moved = { ...start, x: start.x + (end.x - start.x) * step / 5 };
    await comicTouch(session, image, 'touchMove', [moved], [moved]);
  }
  await comicTouch(session, image, 'touchEnd', [], [end]);
}

test.describe('circular comic navigation', () => {
  test.use({ hasTouch: true });
  for (const input of ['button', 'mouse edge', 'touch edge', 'keyboard', 'swipe'] as const) {
    for (const firstWrap of ['backward', 'forward'] as const) {
      test(`CBZ circular ${input} wraps ${firstWrap} then cycles within the selected original`, async ({ page, app, browserName }, info) => {
        await signIn(page, app);
        await openComic(page);
        await page.getByRole('link', { name: 'Read', exact: true }).click();
        await expectPanel(page, 1, 1);
        const readerUrl = page.url();
        if (firstWrap === 'forward') {
          await page.getByLabel('Page number', { exact: true }).fill('3');
          await page.getByRole('button', { name: 'Go to page', exact: true }).click();
          await expectPanel(page, 3, 10);
        }
        const session = input === 'swipe' && browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined;
        const sequence = firstWrap === 'backward'
          ? [[false, 3], [true, 1], [true, 2], [true, 3], [true, 1], [false, 3], [false, 2], [false, 1], [false, 3]] as const
          : [[true, 1], [false, 3], [false, 2], [false, 1], [false, 3], [true, 1], [true, 2], [true, 3], [true, 1]] as const;
        const observations: object[] = [];
        try {
          for (const [forward, expected] of sequence) {
            if (input === 'button') await page.getByRole('button', { name: forward ? 'Next page' : 'Previous page', exact: true }).click({ timeout: 2000 });
            else if (input === 'keyboard') {
              await page.getByRole('region', { name: 'Comic page', exact: true }).focus();
              await page.keyboard.press(forward ? 'ArrowRight' : 'ArrowLeft');
            } else if (input === 'swipe') await swipeComic(page, session, forward);
            else {
              const edge = await pageEdge(page, forward ? 'right' : 'left');
              if (input === 'touch edge') await page.touchscreen.tap(edge.x, edge.y);
              else await page.mouse.click(edge.x, edge.y);
            }
            await expectPanel(page, expected, expected === 3 ? 10 : expected);
            expect(await savedComicPage(page)).toBe(expected);
            await expect(page.getByLabel('Page number', { exact: true })).toHaveValue(String(expected));
            await expect(page).toHaveURL(readerUrl);
            await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();
            await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeEnabled();
            observations.push({ action: forward ? 'next' : 'previous', decodedAndSavedPage: expected });
          }
          const expected = firstWrap === 'backward' ? 3 : 1;
          await capture(page, `cbz-loop-${firstWrap}-${input.replace(/ /g, '-')}`, info);
          await page.getByRole('link', { name: 'Back to book' }).click();
          await page.getByRole('link', { name: 'Read', exact: true }).click();
          await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
          await expectPanel(page, expected, expected === 3 ? 10 : expected);
          await fs.writeFile(info.outputPath('circular-navigation.json'), JSON.stringify({
            input, firstWrap, observations, resumedPage: expected, sameOriginal: true,
            swipe: input === 'swipe' ? (session ? 'trusted native Chromium CDP' : 'synthetic TouchEvent handler') : null,
          }, null, 2));
        } finally { await session?.detach(); }
      });
    }
  }

  test('CBZ one-page original stays on its only decoded and saved page', async ({ page, app, browserName }, info) => {
    await app.setCbz('single');
    await signIn(page, app);
    await openComic(page);
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await expectPanel(page, 1, 1, 1, 1);
    await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
    await expect(page.getByText('This original has one page.', { exact: true })).toBeVisible();
    const session = browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined;
    try {
      for (const forward of [false, true]) {
        const edge = await pageEdge(page, forward ? 'right' : 'left');
        await page.mouse.click(edge.x, edge.y);
        await page.touchscreen.tap(edge.x, edge.y);
        await page.getByRole('region', { name: 'Comic page', exact: true }).focus();
        await page.keyboard.press(forward ? 'ArrowRight' : 'ArrowLeft');
        await swipeComic(page, session, forward);
        await expectPanel(page, 1, 1, 1, 1);
        expect(await savedComicPage(page)).toBe(1);
      }
      await capture(page, 'cbz-one-page', info);
    } finally { await session?.detach(); }
  });
});

test('CBZ direct page jumps stay literal and reject invalid values instead of wrapping', async ({ page, app }) => {
  await signIn(page, app);
  await openComic(page);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expectPanel(page, 1, 1);
  const jump = page.getByLabel('Page number', { exact: true });
  const submit = page.getByRole('button', { name: 'Go to page', exact: true });
  await jump.fill('2'); await submit.click();
  await expectPanel(page, 2, 2);
  for (const invalid of ['0', '4', '1.5', '']) {
    await jump.fill(invalid); await submit.click();
    await expectPanel(page, 2, 2);
    // Also exercise the application guard independently of native input validation.
    await jump.locator('..').dispatchEvent('submit');
    await expect(page.getByRole('alert')).toHaveText('Choose a page from 1 to 3.');
    expect(await savedComicPage(page)).toBe(2);
  }
  await jump.fill('3'); await submit.click(); await expectPanel(page, 3, 10);
  await jump.fill('1'); await submit.click(); await expectPanel(page, 1, 1);
  expect(await savedComicPage(page)).toBe(1);
});

test.describe('visible page-edge navigation', () => {
  test.use({ hasTouch: true });
  for (const gesture of ['swipe', 'tap'] as const) for (const firstReleased of ['image', 'outside'] as const) {
    test(`CBZ cross-target multitouch ${gesture} keeps decoded and saved page when ${firstReleased} releases first`, async ({ page, app, browserName }, info) => {
      await signIn(page, app);
      await openComic(page);
      await page.getByRole('link', { name: 'Read', exact: true }).click();
      await expectPanel(page, 1, 1);
      const image = page.getByRole('img', { name: /Comic page/ });
      const session = browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined;
      const observations: object[] = [];
      await page.evaluate(() => {
        const events: object[] = [];
        Reflect.set(window, 'comicTouchEvents', events);
        for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
          document.addEventListener(type, event => {
            const touch = event as TouchEvent;
            events.push({ type, trusted: event.isTrusted, target: (event.target as Element).tagName,
              touches: Array.from(touch.touches, contact => contact.identifier),
              changed: Array.from(touch.changedTouches, contact => ({ id: contact.identifier, x: contact.clientX, y: contact.clientY })) });
          }, { capture: true, passive: true });
        }
      });
      try {
        for (const outside of [
          page.getByRole('heading', { name: 'The Paper Observatory', exact: true }),
          page.getByRole('group', { name: 'Page navigation', exact: true }).locator('span'),
        ]) {
          const edge = await pageEdge(page, 'left');
          const end = await pageEdge(page, 'right');
          const bounds = (await outside.boundingBox())!;
          // Chromium ends contacts in ID order, emitting separate trusted touchend events.
          const a = { ...edge, id: firstReleased === 'image' ? 11 : 22 };
          const b = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, id: firstReleased === 'image' ? 22 : 11 };
          await page.evaluate(() => { Reflect.get(window, 'comicTouchEvents').length = 0; });
          await comicTouch(session, image, 'touchStart', [a], [a]);
          await comicTouch(session, outside, 'touchStart', [a, b], [b]);
          for (let step = 1; gesture === 'swipe' && step <= 5; step++) {
            a.x = edge.x + (end.x - edge.x) * step / 5;
            await comicTouch(session, image, 'touchMove', [a, b], [a]);
          }
          if (session) {
            await comicTouch(session, image, 'touchEnd', [], [a, b]);
          } else if (firstReleased === 'image') {
            await comicTouch(session, image, 'touchEnd', [b], [a]);
            await comicTouch(session, outside, 'touchEnd', [], [b]);
          } else {
            await comicTouch(session, outside, 'touchEnd', [a], [b]);
            await comicTouch(session, image, 'touchEnd', [], [a]);
          }
          const savedPage = await savedComicPage(page);
          const events: ComicTouchEvent[] = await page.evaluate(() => Reflect.get(window, 'comicTouchEvents'));
          observations.push({ input: session ? 'trusted native Chromium CDP' : 'synthetic TouchEvent handler coverage',
            outside: await outside.evaluate(element => element.tagName), gesture, firstReleased, events, savedPage });
          await fs.writeFile(info.outputPath('cross-target-touch.json'), JSON.stringify(observations, null, 2));
          expect(events.map(event => event.trusted)).toEqual(events.map(() => Boolean(session)));
          expect(events.slice(0, 2).map(event => [event.type, event.target, event.touches.length])).toEqual([
            ['touchstart', 'IMG', 1], ['touchstart', await outside.evaluate(element => element.tagName), 2],
          ]);
          if (gesture === 'swipe') {
            expect(events.filter(event => event.type === 'touchmove' && event.touches.length === 2).length).toBeGreaterThan(0);
          }
          const releases = events.filter(event => event.type === 'touchend');
          expect(releases.map(event => event.changed.map(contact => contact.id))).toEqual(firstReleased === 'image'
            ? [[a.id], [b.id]] : [[b.id], [a.id]]);
          expect(releases.map(event => event.touches.length)).toEqual([1, 0]);
          const releasedImage = releases.find(event => event.changed[0].id === a.id)!.changed[0];
          if (gesture === 'swipe') expect(releasedImage.x - edge.x).toBeGreaterThan(60);
          expect(Math.abs(releasedImage.y - edge.y)).toBeLessThan(40);
          expect.soft(savedPage).toBe(1);
          await expectPanel(page, 1, 1);
        }
        const edge = await pageEdge(page, 'right');
        await page.touchscreen.tap(edge.x, edge.y);
        await expectPanel(page, 2, 2);
        const tapSaved = await savedComicPage(page);
        expect(tapSaved).toBe(2);
        const a = { ...await pageEdge(page, 'right'), id: 33 };
        const end = await pageEdge(page, 'left');
        await comicTouch(session, image, 'touchStart', [a], [a]);
        for (let step = 1; step <= 5; step++) {
          const moved = { ...a, x: a.x + (end.x - a.x) * step / 5 };
          await comicTouch(session, image, 'touchMove', [moved], [moved]);
        }
        await comicTouch(session, image, 'touchEnd', [], [{ ...a, x: end.x }]);
        await expectPanel(page, 3, 10);
        const swipeSaved = await savedComicPage(page);
        expect(swipeSaved).toBe(3);
        observations.push({ recovery: 'clean single-contact tap then swipe', tap: 'native browser touchscreen',
          swipe: session ? 'trusted native Chromium CDP' : 'synthetic TouchEvent handler coverage', savedPages: [tapSaved, swipeSaved] });
        await fs.writeFile(info.outputPath('cross-target-touch.json'), JSON.stringify(observations, null, 2));
      } finally { await session?.detach(); }
    });
  }

  test('CBZ cancelled touch cannot save a turn and a clean touch still works', async ({ page, app, browserName }, info) => {
    await signIn(page, app);
    await openComic(page);
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await expectPanel(page, 1, 1);
    const image = page.getByRole('img', { name: /Comic page/ });
    const session = browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined;
    try {
      const a = { ...await pageEdge(page, 'left'), id: 41 };
      const end = { ...await pageEdge(page, 'right'), id: 41 };
      await comicTouch(session, image, 'touchStart', [a], [a]);
      await comicTouch(session, image, 'touchMove', [end], [end]);
      await comicTouch(session, image, 'touchCancel', [], [end]);
      // A stale fallback completion must not resurrect a cancelled contact.
      await comicTouch(undefined, image, 'touchEnd', [], [end]);
      expect(await savedComicPage(page)).toBe(1);
      await expectPanel(page, 1, 1);
      const edge = await pageEdge(page, 'right');
      await page.touchscreen.tap(edge.x, edge.y);
      await expectPanel(page, 2, 2);
      expect(await savedComicPage(page)).toBe(2);
      await fs.writeFile(info.outputPath('cancelled-touch.json'), JSON.stringify({
        cancellation: session ? 'trusted native Chromium CDP touchCancel' : 'synthetic TouchEvent handler coverage',
        staleCompletion: 'synthetic touchend', cleanTap: 'native browser touchscreen', savedPages: [1, 2],
      }, null, 2));
    } finally { await session?.detach(); }
  });

  test('CBZ touch contact identity rejects an unrelated completion', async ({ page, app }) => {
    await signIn(page, app);
    await openComic(page);
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await expectPanel(page, 1, 1);
    const image = page.getByRole('img', { name: /Comic page/ });
    const a = { ...await pageEdge(page, 'left'), id: 51 };
    const unrelated = { ...await pageEdge(page, 'right'), id: 52 };
    await comicTouch(undefined, image, 'touchStart', [a], [a]);
    await comicTouch(undefined, image, 'touchEnd', [], [unrelated]);
    expect(await savedComicPage(page)).toBe(1);
    await expectPanel(page, 1, 1);
    const edge = await pageEdge(page, 'right');
    await page.touchscreen.tap(edge.x, edge.y);
    await expectPanel(page, 2, 2);
    expect(await savedComicPage(page)).toBe(2);
  });

  test('CBZ swipes do not double-turn and zoomed panning never turns', async ({ page, app, browserName }, info) => {
    await signIn(page, app);
    await openComic(page);
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await expectPanel(page, 1, 1);
    const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
    const session = browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined;
    const start = await pageEdge(page, 'right');
    const end = await pageEdge(page, 'left');
    const swipe = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      if (session) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 0 }] });
        for (let step = 1; step <= 5; step++) await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * step / 5, y: from.y, id: 0 }],
        });
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await viewport.dispatchEvent('touchstart', { touches: [{ identifier: 0, clientX: from.x, clientY: from.y }] });
        await viewport.dispatchEvent('touchend', { changedTouches: [{ identifier: 0, clientX: to.x, clientY: to.y }] });
      }
    };
    try {
      await swipe(start, end);
      await expectPanel(page, 2, 2);
      const nextEdge = await pageEdge(page, 'right');
      await page.getByRole('img', { name: /Comic page/ }).dispatchEvent('click',
        { detail: 1, button: 0, clientX: nextEdge.x, clientY: nextEdge.y });
      await expectPanel(page, 2, 2);
      await page.touchscreen.tap(nextEdge.x, nextEdge.y);
      await expectPanel(page, 3, 10);
      await page.getByLabel('Page number', { exact: true }).fill('1');
      await page.getByRole('button', { name: 'Go to page', exact: true }).click();
      await expectPanel(page, 1, 1);
      await setViewOption(page, 'Zoom', '300');
      expect(await viewport.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
      await viewport.evaluate(element => { element.scrollLeft = 0; });
      await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBe(0);
      const panStart = await pageEdge(page, 'right');
      const panEnd = await pageEdge(page, 'left');
      await swipe(panStart, panEnd);
      if (session) await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
      else {
        await viewport.hover(); await page.mouse.wheel(150, 0);
        await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
      }
      await expectPanel(page, 1, 1);
      await fs.writeFile(info.outputPath('swipe-input.json'), JSON.stringify({
        engine: browserName, swipe: session ? 'trusted native CDP touch' : 'synthetic TouchEvent handler coverage',
        tap: 'native browser touchscreen', pan: session ? 'trusted native touch' : 'native browser wheel',
        duplicateClickIgnored: true, panPageUnchanged: true,
      }, null, 2));
    } finally { await session?.detach(); }
  });

  for (const input of ['mouse', 'touch'] as const) {
    test(`CBZ actual visible image edges turn one page with ${input}`, async ({ page, app }, info) => {
      await signIn(page, app);
      await openComic(page);
      await page.getByRole('link', { name: 'Read', exact: true }).click();
      await expectPanel(page, 1, 1);
      const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
      const image = page.getByRole('img', { name: /Comic page/ });
      if (page.viewportSize()!.width >= 1000) {
        expect((await image.boundingBox())!.width).toBeLessThan((await viewport.boundingBox())!.width * 0.65);
      }
      const edge = await pageEdge(page, 'right');
      if (input === 'touch') await page.touchscreen.tap(edge.x, edge.y);
      else await page.mouse.click(edge.x, edge.y);
      await expectPanel(page, 2, 2);
      await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('2');
      const forward = await pageEdge(page, 'right');
      if (input === 'touch') await page.touchscreen.tap(forward.x, forward.y);
      else await page.mouse.click(forward.x, forward.y);
      await expectPanel(page, 3, 10);
      await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();
      if (input === 'touch') await page.touchscreen.tap(forward.x, forward.y);
      else await page.mouse.click(forward.x, forward.y);
      await expectPanel(page, 1, 1);
      const back = await pageEdge(page, 'left');
      if (input === 'touch') await page.touchscreen.tap(back.x, back.y);
      else await page.mouse.click(back.x, back.y);
      await expectPanel(page, 3, 10);
      if (input === 'touch') await page.touchscreen.tap(back.x, back.y);
      else await page.mouse.click(back.x, back.y);
      await expectPanel(page, 2, 2);
      await capture(page, `cbz-${input}-edge-page-2`, info);
      await page.getByRole('link', { name: 'Back to book' }).click();
      await page.getByRole('link', { name: 'Read', exact: true }).click();
      await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
      await expectPanel(page, 2, 2);
    });
  }
});

test('CBZ edge activation ignores center margins drag scroll selection and long press', async ({ page, app }, info) => {
  await signIn(page, app);
  await openComic(page);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expectPanel(page, 1, 1);
  const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
  const image = page.getByRole('img', { name: /Comic page/ });
  const box = (await image.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expectPanel(page, 1, 1);
  const view = (await viewport.boundingBox())!;
  if (box.x - view.x > 20) {
    await page.mouse.click(view.x + 5, box.y + box.height / 2);
    await expectPanel(page, 1, 1);
  }
  const edge = await pageEdge(page, 'left');
  await page.mouse.move(edge.x, edge.y); await page.mouse.down();
  await page.mouse.move(edge.x + 45, edge.y + 25, { steps: 4 });
  await page.mouse.move(edge.x, edge.y, { steps: 4 }); await page.mouse.up();
  await expectPanel(page, 1, 1);
  await page.mouse.move(edge.x, edge.y); await page.mouse.down();
  await viewport.dispatchEvent('contextmenu');
  await page.mouse.up();
  await expectPanel(page, 1, 1);
  await page.mouse.down();
  const started = await page.evaluate(() => performance.now());
  await expect.poll(() => page.evaluate(() => performance.now())).toBeGreaterThan(started + 600);
  await page.mouse.up();
  await expectPanel(page, 1, 1);
  await page.getByRole('heading', { name: 'The Paper Observatory', exact: true }).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await page.mouse.click(edge.x, edge.y);
  await expectPanel(page, 1, 1);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.getByRole('button', { name: 'View options', exact: true }).click();
  await expectPanel(page, 1, 1);
  await capture(page, 'cbz-compact-options-open', info);
  await page.getByRole('button', { name: 'View options', exact: true }).click();
  await setViewOption(page, 'Zoom', '200');
  const zoomEdge = await pageEdge(page, 'left');
  const scrollTop = await viewport.evaluate(element => element.scrollTop);
  await page.mouse.move(zoomEdge.x, zoomEdge.y); await page.mouse.down();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeCloseTo(scrollTop + 200, 0);
  await page.mouse.up();
  await expectPanel(page, 1, 1);
  const cleanEdge = await pageEdge(page, 'right');
  await page.mouse.click(cleanEdge.x, cleanEdge.y);
  await expectPanel(page, 2, 2);
});

test.describe('actual-clock page selection', () => {
  test.use({ controlledReaderClock: false });
  test('CBZ Next and edge remain selected through delayed real saves resources and autosave', async ({ page, app }, info) => {
    test.setTimeout(115000);
    await signIn(page, app);
    await openComic(page);
    const prepared = page.waitForResponse(response => response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/reader'));
    const firstSaved = page.waitForResponse(response => response.request().method() === 'PUT' &&
      response.url().endsWith('/progress/ebook') && response.status() === 200 &&
      response.request().postDataJSON().op === 'save');
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    const descriptor = parseReader(await (await prepared).json());
    expect(descriptor.policyVersion).toBe('cbz-pages-v1');
    await expectPanel(page, 1, 1); await firstSaved;
    const observations: object[] = [];
    for (const [from, to, action] of [[1, 2, 'next'], [2, 1, 'left'], [1, 3, 'previous'], [3, 1, 'right']] as const) {
      let heldSave: Route | undefined; let heldResource: Route | undefined;
      let saveHeld = false; let resourceHeld = false;
      await page.route('**/progress/ebook', route => {
        const request = route.request();
        if (request.method() === 'PUT' && request.postDataJSON().op === 'save' &&
            request.postDataJSON().locator.page === from && !saveHeld) {
          saveHeld = true; heldSave = route; return;
        }
        return route.continue();
      });
      await page.route('**/readers/*/resources/*', route => {
        if (route.request().url().endsWith(`/${descriptor.spine[to - 1]}`) && !resourceHeld) {
          resourceHeld = true; heldResource = route; return;
        }
        return route.continue();
      });
      const saved = page.waitForResponse(response => response.request().method() === 'PUT' &&
        response.url().endsWith('/progress/ebook') && response.status() === 200 &&
        response.request().postDataJSON().locator.page === to);
      if (action === 'next' || action === 'previous') {
        await page.getByRole('button', { name: action === 'next' ? 'Next page' : 'Previous page', exact: true }).click();
      }
      else {
        const edge = await pageEdge(page, action); await page.mouse.click(edge.x, edge.y);
      }
      await expect.poll(() => Boolean(heldSave && heldResource)).toBe(true);
      await expect(page.getByRole('region', { name: 'Comic page', exact: true })).toHaveAttribute('aria-busy', 'true');
      await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
      await heldResource!.continue();
      await expectPanel(page, to, to === 3 ? 10 : to);
      await heldSave!.continue();
      expect((await (await saved).json()).progress.locator.page).toBe(to);
      await expectPanel(page, to, to === 3 ? 10 : to);
      await page.unroute('**/progress/ebook');
      await page.unroute('**/readers/*/resources/*');
      const after = Date.now() + 8000;
      const autosave = await page.waitForResponse(response => response.request().method() === 'PUT' &&
        response.url().endsWith('/progress/ebook') && response.status() === 200 &&
        response.request().timing().startTime >= after, { timeout: 25000 });
      expect((await autosave.json()).progress.locator.page).toBe(to);
      await expectPanel(page, to, to === 3 ? 10 : to);
      await expect(page.getByLabel('Page number', { exact: true })).toHaveValue(String(to));
      observations.push({ action, from, selectedPage: to,
        delayedOldSaveReleasedAfterNewImage: true, realPeriodicSavePage: to });
    }
    await fs.writeFile(info.outputPath('actual-clock-turns.json'), JSON.stringify(observations, null, 2));
  });
});

test('CBZ same-input detail and real numbered pages', async ({ page, app }, info) => {
  await signIn(page, app);
  await openComic(page);
  await expect(page.getByLabel('Ebook original').locator('option')).toHaveCount(2);
  await capture(page, 'cbz-detail', info);
  if (process.env.BOOKS_CBZ_BEFORE === 'true') {
    await expect(page.getByRole('button', { name: 'Read', exact: true })).toBeDisabled();
    return;
  }
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  const image = page.getByRole('img', { name: 'Comic page 1 of 3', exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(480);
  await expectPanel(page, 1, 1);
  await expect(page.getByText('Left: previous. Right: next. First and last pages connect within this original.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeEnabled();
  const next = page.getByRole('button', { name: 'Next page', exact: true });
  await expect(next).toBeEnabled();
  await expect.poll(() => next.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
  await capture(page, 'cbz-reader-page-1', info);
  const originalSize = page.viewportSize()!;
  const geometry: object[] = [];
  for (const width of [320, 768, originalSize.width]) {
    await page.setViewportSize({ ...originalSize, width });
    const navigation = page.getByRole('group', { name: 'Page navigation', exact: true });
    const bounds = (await navigation.boundingBox())!;
    expect(bounds.height).toBeLessThanOrEqual(46);
    for (const control of await navigation.locator('button, input').all()) {
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    geometry.push({ width, toolbarHeight: bounds.height, allTargetsAtLeast44: true, documentOverflow: false });
  }
  await fs.writeFile(info.outputPath('compact-controls-geometry.json'), JSON.stringify(geometry, null, 2));
  await page.getByRole('region', { name: 'Comic page' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('img', { name: 'Comic page 2 of 3', exact: true })).toBeVisible();
  await expectPanel(page, 2, 2);
  await page.getByRole('region', { name: 'Comic page' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('img', { name: 'Comic page 3 of 3', exact: true })).toBeVisible();
  await expectPanel(page, 3, 10);
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();
  await page.getByLabel('Page number', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Go to page', exact: true }).click();
  await expect(image).toBeVisible();
  await setViewOption(page, 'Page fit', 'width');
  await setViewOption(page, 'Zoom', '200');
  await expect(page.getByRole('region', { name: 'Comic page' })).toHaveAttribute('data-decoded-pixels', '345600');
  await capture(page, 'cbz-reader-zoom', info);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('CBZ originals keep independent private progress across handles cache and backend restart', async ({ page, app }, info) => {
  await signIn(page, app);
  await openComic(page);
  await expect(page.getByLabel('Ebook original').locator('option')).toHaveCount(2);
  const options = await page.getByLabel('Ebook original').locator('option').evaluateAll(elements =>
    elements.map(element => (element as HTMLOptionElement).value));
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Comic page 1 of 3', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Comic page 2 of 3', exact: true })).toBeVisible();
  await expect(page.getByText('Position saved', { exact: true })).toBeVisible();
  app.advanceReaderTime(31 * 60 * 1000);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Comic page 3 of 3', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to book' }).click();
  await page.getByLabel('Ebook original').selectOption(options[1]);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Comic page 1 of 3', exact: true })).toBeVisible();
  await expectPanel(page, 1, 1, 2);
  await expect(page.getByRole('button', { name: 'Resume saved position' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Comic page 2 of 3', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to book' }).click();
  app.advanceReaderTime(24 * 60 * 60 * 1000);
  await page.getByLabel('Ebook original').selectOption(options[0]);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Comic page 3 of 3', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to book' }).click();
  await app.restart();
  await page.reload();
  await page.getByLabel('Ebook original').selectOption(options[1]);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Comic page 2 of 3', exact: true })).toBeVisible();
  await capture(page, 'cbz-chapter-B-resumed', info);
  await expectPanel(page, 2, 2, 2);
  await signIn(page, app, 1);
  await openComic(page);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Comic page 1 of 3', exact: true })).toBeVisible();
});

test('CBZ corrupt pages fail honestly and original bytes still download unchanged', async ({ page, app }, info) => {
  await app.setCbz('corrupt');
  await signIn(page, app);
  await openComic(page);
  const { buildCbzFixture, comicPanel } = await import('../../../backend/dist/books/proof/cbzFixture.js');
  const expected = await buildCbzFixture([10, 2, 1].map(number => ({
    name: `Pages/${number}.png`, data: number === 2 ? Buffer.from('Damaged generated page') : comicPanel(number, 1),
  })));
  const download = await originalDownload(page, () => page.getByRole('button', { name: 'Download original Observatory - chapter A.cbz', exact: true }).click(), info);
  const downloaded = await download.path();
  expect(downloaded).toBeTruthy();
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  expect(hash(await fs.readFile(downloaded!))).toBe(hash(expected));
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /CBZ.*download/i })).toBeVisible();
  await expect(page.getByRole('img', { name: /Comic page/ })).toHaveCount(0);
});

test('CBZ cancels abandoned turns and releases every page URL on configuration revocation', async ({ page, app }) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL; const revoke = URL.revokeObjectURL;
    const urls = new Set<string>();
    Object.defineProperty(window, 'comicObjectUrls', { get: () => urls.size });
    URL.createObjectURL = blob => { const url = create(blob); urls.add(url); return url; };
    URL.revokeObjectURL = url => { urls.delete(url); revoke(url); };
  });
  await signIn(page, app);
  await openComic(page);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Comic page 1 of 3', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Comic page 2 of 3', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /Comic page/ })).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'comicObjectUrls'))).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('librarydownloadarr:books-changed')));
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
  await expect(page.getByRole('img', { name: /Comic page/ })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'comicObjectUrls'))).toBe(0);
});

test('CBZ within-page position survives zoom reflow reopen and explicit writer takeover', async ({ page, app, browser }, info) => {
  await signIn(page, app);
  await openComic(page);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expectPanel(page, 1, 1);
  const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
  await setViewOption(page, 'Zoom', '200');
  await expect.poll(() => page.getByRole('img', { name: 'Comic page 1 of 3', exact: true }).evaluate(element => element.getBoundingClientRect().width)).toBe(960);
  await viewport.evaluate(element => { element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.6; });
  await expectFraction(viewport, 'vertical', 0.6);
  await setViewOption(page, 'Zoom', '300');
  await expectFraction(viewport, 'vertical', 0.6);
  await page.getByRole('link', { name: 'Back to book' }).click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
  await expectPanel(page, 1, 1);
  const zoomSaved = page.waitForResponse(response => {
    if (!response.url().endsWith('/progress/ebook') || response.request().method() !== 'PUT' || response.status() !== 200) return false;
    const write = response.request().postDataJSON();
    return write.op === 'save' && write.locator.kind === 'cbz' && write.locator.page === 1 &&
      Math.abs(write.locator.offset - 0.6) < 0.005;
  });
  await setViewOption(page, 'Zoom', '200');
  await expectFraction(viewport, 'vertical', 0.6);
  await zoomSaved;
  const context = await browser.newContext({ baseURL: app.origin, ignoreHTTPSErrors: true, viewport: page.viewportSize() });
  await context.route('**/*', route => new URL(route.request().url()).origin === app.origin ? route.continue() : route.abort());
  try {
    const other = await context.newPage();
    await signIn(other, app, 3);
    await openComic(other);
    await other.getByRole('link', { name: 'Read', exact: true }).click();
    await other.getByRole('button', { name: 'Resume saved position', exact: true }).click();
    await expectPanel(other, 1, 1);
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Continue here', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Continue here', exact: true }).click();
    await expectPanel(page, 2, 2);
    await expect(page.getByText('Position saved', { exact: true })).toBeVisible();
    await capture(page, 'cbz-explicit-takeover', info);
  } finally { await context.close(); }
});

for (const axis of ['vertical', 'horizontal'] as const) {
  test(`CBZ ${axis} bookmark survives viewport growth clamping and saved reopen`, async ({ page, app }, info) => {
    await signIn(page, app);
    await openComic(page);
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await expectPanel(page, 1, 1);
    const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
    await setViewOption(page, 'Zoom', '300');
    await expect.poll(() => page.getByRole('img', { name: 'Comic page 1 of 3', exact: true })
      .evaluate(element => element.getBoundingClientRect().width)).toBe(1440);
    await viewport.evaluate((element, axis) => {
      if (axis === 'vertical') element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.6;
      else element.scrollLeft = (element.scrollWidth - element.clientWidth) * 0.6;
    }, axis);
    await expectFraction(viewport, axis, 0.6);
    await page.getByRole('link', { name: 'Back to book' }).click();
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
    await expectPanel(page, 1, 1);
    await setViewOption(page, 'Zoom', '300');
    await expectFraction(viewport, axis, 0.6);
    const before = await viewport.evaluate(element => ({
      top: element.scrollTop, left: element.scrollLeft,
      height: element.scrollHeight, width: element.scrollWidth,
    }));
    const size = page.viewportSize()!;
    await page.setViewportSize(axis === 'vertical' ? { ...size, height: 1900 } : { ...size, width: 1370 });
    const after = await viewport.evaluate(element => ({
      vertical: element.scrollHeight - element.clientHeight,
      horizontal: element.scrollWidth - element.clientWidth,
    }));
    expect(axis === 'vertical' ? before.top : before.left).toBeGreaterThan(after[axis]);
    expect(after[axis]).toBeGreaterThan(0);
    await expectFraction(viewport, axis, 0.6);
    await capture(page, `cbz-${axis}-clamp-preserved`, info);
    await page.getByRole('link', { name: 'Back to book' }).click();
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
    await expectPanel(page, 1, 1);
    await setViewOption(page, 'Zoom', '300');
    await expectFraction(viewport, axis, 0.6);
  });
}

test('CBZ fast real scrolling is captured before resize and saved reopen', async ({ page, app }) => {
  await signIn(page, app);
  await openComic(page);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expectPanel(page, 1, 1);
  const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
  await setViewOption(page, 'Zoom', '300');
  await expect.poll(() => page.getByRole('img', { name: 'Comic page 1 of 3', exact: true })
    .evaluate(element => element.getBoundingClientRect().width)).toBe(1440);
  await viewport.hover();
  await page.mouse.wheel(0, 360);
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeCloseTo(360, 0);
  const fraction = await viewport.evaluate(element => element.scrollTop / (element.scrollHeight - element.clientHeight));
  expect(fraction).toBeGreaterThan(0.05);
  expect(fraction).toBeLessThan(0.9);
  await page.setViewportSize({ ...page.viewportSize()!, height: 1000 });
  await expectFraction(viewport, 'vertical', fraction);
  await page.getByRole('link', { name: 'Back to book' }).click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
  await expectPanel(page, 1, 1);
  await setViewOption(page, 'Zoom', '300');
  await expectFraction(viewport, 'vertical', fraction);
});

test('CBZ movement in the restoration frame survives resize and page transition', async ({ page, app }) => {
  await signIn(page, app);
  await openComic(page);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expectPanel(page, 1, 1);
  const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
  await viewport.evaluate(element => {
    const image = element.querySelector('img')!;
    const observer = new MutationObserver(() => {
      if (image.getBoundingClientRect().width !== 1440) return;
      observer.disconnect();
      element.addEventListener('scroll', () => { element.setAttribute('data-fast-scroll-observed', 'true'); }, { once: true });
      element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.6;
    });
    observer.observe(image, { attributes: true, attributeFilter: ['style'] });
  });
  await setViewOption(page, 'Zoom', '300');
  await expect(viewport).toHaveAttribute('data-fast-scroll-observed', 'true');
  await page.setViewportSize({ ...page.viewportSize()!, height: 1000 });
  await expectFraction(viewport, 'vertical', 0.6);
  await page.getByRole('link', { name: 'Back to book' }).click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
  await expectPanel(page, 1, 1);
  await setViewOption(page, 'Zoom', '300');
  await expectFraction(viewport, 'vertical', 0.6);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expectPanel(page, 2, 2);
  await expectFraction(viewport, 'vertical', 0);
  await expectFraction(viewport, 'horizontal', 0);
});

test('CBZ replaced originals retain incompatible history and failed saves retry without losing a rewind', async ({ page, app }) => {
  await signIn(page, app);
  await openComic(page);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expectPanel(page, 1, 1);
  await page.route('**/progress/ebook', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"BOOKS_UNAVAILABLE","error":"Fixture network interruption"}' })
    : route.continue());
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expectPanel(page, 2, 2);
  await expect(page.getByText('Position not saved yet.', { exact: true })).toBeVisible();
  await page.unroute('**/progress/ebook');
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expectPanel(page, 1, 1);
  await expect(page.getByText('Position saved', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to book' }).click();
  await app.setCbz('replacement');
  await page.reload();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByText('The original or reader policy changed.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume saved position', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start from beginning', exact: true }).click();
  await expectPanel(page, 1, 2);
});

test.describe('touch-enabled comic reader', () => {
  test.use({ hasTouch: true });
  test('CBZ touch turning and literal page jumps preserve semantic page order', async ({ page, app }) => {
  await signIn(page, app);
  await openComic(page);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expectPanel(page, 1, 1);
  const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
  await viewport.dispatchEvent('touchstart', { touches: [{ identifier: 0, clientX: 220, clientY: 80 }] });
  await viewport.dispatchEvent('touchend', { changedTouches: [{ identifier: 0, clientX: 80, clientY: 80 }] });
  await expectPanel(page, 2, 2);
  await viewport.dispatchEvent('touchstart', { touches: [{ identifier: 0, clientX: 220, clientY: 80 }] });
  await viewport.dispatchEvent('touchend', { changedTouches: [{ identifier: 0, clientX: 80, clientY: 80 }] });
  await expectPanel(page, 3, 10);
  await page.getByLabel('Page number', { exact: true }).fill('4');
  await page.getByRole('button', { name: 'Go to page', exact: true }).click();
  await expectPanel(page, 3, 10);
  await viewport.focus(); await page.keyboard.press('Home');
  await expectPanel(page, 1, 1);
  for (const box of await page.locator('button:visible, select:visible, input:visible').all()) {
    expect((await box.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  });
});
