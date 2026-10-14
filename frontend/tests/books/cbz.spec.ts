import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { test, expect, signIn, capture, originalDownload } from './harness';

test.use({ cbzFixtures: true, controlledReaderClock: true, reverseProxy: true });

async function openComic(page: Page) {
  const card = page.getByRole('link', { name: 'Open The Paper Observatory', exact: true });
  await card.scrollIntoViewIfNeeded();
  // The fixture's absent cover must not remove the pointer target during the click.
  await expect(card.getByRole('img')).toHaveCount(0);
  await card.click();
  await expect(page.getByLabel('Ebook original').locator('option')).toHaveCount(2);
}

async function expectPanel(page: Page, position: number, panel: number, chapter = 1) {
  const image = page.getByRole('img', { name: `Comic page ${position} of 3`, exact: true });
  await expect(image).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Reading direction: right to left' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
  await capture(page, 'cbz-reader-page-1', info);
  await page.getByRole('region', { name: 'Comic page' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('img', { name: 'Comic page 2 of 3', exact: true })).toBeVisible();
  await expectPanel(page, 2, 2);
  await page.getByRole('button', { name: 'Reading direction: right to left' }).click();
  await page.getByRole('region', { name: 'Comic page' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('img', { name: 'Comic page 3 of 3', exact: true })).toBeVisible();
  await expectPanel(page, 3, 10);
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  await page.getByLabel('Page number', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Go to page', exact: true }).click();
  await expect(image).toBeVisible();
  await page.getByRole('combobox', { name: 'Page fit', exact: true }).selectOption('width');
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('200');
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
  await expect(page.getByRole('img', { name: /Comic page/ })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'comicObjectUrls'))).toBe(0);
});

test('CBZ within-page position survives zoom reflow reopen and explicit writer takeover', async ({ page, app, browser }, info) => {
  await signIn(page, app);
  await openComic(page);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expectPanel(page, 1, 1);
  const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('200');
  await expect.poll(() => page.getByRole('img', { name: 'Comic page 1 of 3', exact: true }).evaluate(element => element.getBoundingClientRect().width)).toBe(960);
  await viewport.evaluate(element => { element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.6; });
  await expectFraction(viewport, 'vertical', 0.6);
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('300');
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
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('200');
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
    const zoom = page.getByRole('combobox', { name: 'Zoom', exact: true });
    await zoom.selectOption('300');
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
    await zoom.selectOption('300');
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
    await zoom.selectOption('300');
    await expectFraction(viewport, axis, 0.6);
  });
}

test('CBZ fast real scrolling is captured before resize and saved reopen', async ({ page, app }) => {
  await signIn(page, app);
  await openComic(page);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expectPanel(page, 1, 1);
  const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('300');
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
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('300');
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
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('300');
  await expect(viewport).toHaveAttribute('data-fast-scroll-observed', 'true');
  await page.setViewportSize({ ...page.viewportSize()!, height: 1000 });
  await expectFraction(viewport, 'vertical', 0.6);
  await page.getByRole('link', { name: 'Back to book' }).click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
  await expectPanel(page, 1, 1);
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('300');
  await expectFraction(viewport, 'vertical', 0.6);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expectPanel(page, 2, 2);
  await expectFraction(viewport, 'vertical', 0);
  await expectFraction(viewport, 'horizontal', 1);
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
  test('CBZ touch turning and page bounds preserve semantic page order', async ({ page, app }) => {
  await signIn(page, app);
  await openComic(page);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expectPanel(page, 1, 1);
  const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
  await viewport.dispatchEvent('touchstart', { touches: [{ identifier: 0, clientX: 80, clientY: 80 }] });
  await viewport.dispatchEvent('touchend', { changedTouches: [{ identifier: 0, clientX: 220, clientY: 80 }] });
  await expectPanel(page, 2, 2);
  await page.getByRole('button', { name: 'Reading direction: right to left' }).click();
  await viewport.dispatchEvent('touchstart', { touches: [{ identifier: 0, clientX: 220, clientY: 80 }] });
  await viewport.dispatchEvent('touchend', { changedTouches: [{ identifier: 0, clientX: 80, clientY: 80 }] });
  await expectPanel(page, 3, 10);
  await page.getByLabel('Page number', { exact: true }).fill('4');
  await page.getByRole('button', { name: 'Go to page', exact: true }).click();
  await expectPanel(page, 3, 10);
  await viewport.focus(); await page.keyboard.press('Home');
  await expectPanel(page, 1, 1);
  for (const box of await page.locator('button, select, input').all()) {
    expect((await box.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  });
});
