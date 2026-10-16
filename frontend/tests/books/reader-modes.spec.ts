import fs from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, signIn, capture, revealReaderControls } from './harness';
import { parseBookItem, parseProgress } from '../../src/books/types';

test.use({ cbzFixtures: true, hasTouch: true });

async function open(page: Page, format: 'cbz' | 'pdf' | 'epub') {
  const card = page.getByRole('link', { name: format === 'cbz' ? 'Open The Paper Observatory' : 'Open A Tale in Two Formats', exact: true });
  await expect(card.getByRole('img')).toHaveCount(0);
  await card.click();
  if (format === 'pdf') await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  if (format === 'cbz') await expect(page.getByRole('img', { name: 'Comic page 1 of 3', exact: true })).toBeVisible();
  else if (format === 'pdf') await expect(page.getByText('Generated PDF page 1', { exact: true })).toBeVisible();
  else await expect(page.frameLocator('iframe').getByRole('heading', { name: 'First section' })).toBeVisible();
}

for (const format of ['cbz', 'pdf', 'epub'] as const) {
  test(`${format} defaults continuous and remembers an explicit user mode`, async ({ page, app }, info) => {
    await signIn(page, app);
    await open(page, format);
    await capture(page, `${format}-initial`, info);
    await expect(page.getByLabel('Reading mode')).toHaveValue('continuous');
    await page.getByLabel('Reading mode').selectOption('paged');
    await capture(page, `${format}-paged`, info);
    await page.reload();
    await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
    await expect(page.getByLabel('Reading mode')).toHaveValue('paged');
    await signIn(page, app, 1);
    await open(page, format);
    await expect(page.getByLabel('Reading mode')).toHaveValue('continuous');
  });

  test(`${format} fullscreen hides all chrome and restores focus on exit`, async ({ page, app, browserName }, info) => {
    await signIn(page, app);
    await open(page, format);
    const supported = await page.evaluate(() => document.fullscreenEnabled);
    await page.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Back to book' })).toBeHidden();
    const controls = format === 'epub' ? page.frameLocator('iframe').getByRole('navigation') :
      format === 'pdf' ? page.getByRole('navigation', { name: 'PDF controls' }) :
        page.getByRole('group', { name: 'Page navigation' });
    await expect(controls).toBeHidden();
    expect(await page.locator('main').evaluate(element => element.getBoundingClientRect().height)).toBe(await page.evaluate(() => innerHeight));
    const native = await page.evaluate(() => Boolean(document.fullscreenElement));
    if (browserName === 'chromium' && supported) expect(native).toBe(true);
    if (!native) await expect(page.getByRole('status').getByText('Viewport-only view', { exact: true })).toBeVisible();
    await capture(page, `${format}-fullscreen`, info);
    await revealReaderControls(page);
    const exit = page.getByRole('button', { name: 'Exit full screen', exact: true });
    const bounds = await exit.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    await expect(controls).toBeVisible();
    await exit.click();
    await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toBeFocused();
    await expect(page.getByRole('link', { name: 'Back to book' })).toBeVisible();
    await fs.writeFile(info.outputPath(`${format}-fullscreen.json`), JSON.stringify({
      native, supported, browserName, viewport: page.viewportSize(), headless: true,
      input: await page.evaluate(() => ({ maxTouchPoints: navigator.maxTouchPoints,
        coarse: matchMedia('(pointer: coarse)').matches })), bounds,
    }, null, 2));
  });
}

test('fullscreen preserves active audio without reserving hidden player height and closes on session change', async ({ page, app, context }) => {
  await app.setAudio('normal');
  await signIn(page, app);
  await page.goto(`${app.origin}/audiobooks`);
  await page.getByTestId('books-audio').evaluate(element => { (element as HTMLAudioElement).volume = 0; });
  await page.getByRole('link', { name: 'Open A Tale in Two Formats' }).click();
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Audiobook player' })).toBeVisible();
  const menu = page.getByRole('button', { name: 'Toggle menu', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Books', exact: true }).click();
  await page.getByRole('link', { name: 'Open A Tale in Two Formats' }).click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'First section' })).toBeVisible();
  const audio = page.getByTestId('books-audio');
  await expect.poll(() => audio.evaluate(element => !(element as HTMLAudioElement).paused)).toBe(true);
  const before = await audio.evaluate(element => (element as HTMLAudioElement).currentTime);
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect(page.locator('main')).not.toHaveAttribute('data-reader-fullscreen', 'normal');
  expect(await page.locator('main').evaluate(element => element.getBoundingClientRect().height)).toBe(await page.evaluate(() => innerHeight));
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(before);
  const second = await context.newPage();
  try {
    await signIn(second, app, 1);
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  } finally { await second.close(); }
});

test('PDF applies mode changes made while its first range is pending', async ({ page, app }) => {
  let release!: () => void, held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/content?*', async route => {
    if (route.request().method() === 'GET' && !held) { held = true; await gate; }
    await route.continue();
  });
  try {
    await signIn(page, app);
    await page.getByRole('link', { name: 'Open A Tale in Two Formats' }).click();
    await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await expect.poll(() => held).toBe(true);
    await page.getByLabel('Reading mode').selectOption('paged');
    release();
    await expect(page.getByText('Generated PDF page 1', { exact: true })).toBeVisible();
    await expect(page.getByTestId('pdf-reader').locator('canvas')).toHaveCount(1);
  } finally { release(); }
});

test('EPUB applies paged mode during a held section navigation without retaining neighbors', async ({ page, app }) => {
  let secondId = '', requests = 0;
  let releaseFirst!: () => void, releaseNext!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const next = new Promise<void>(resolve => { releaseNext = resolve; });
  await page.route('**/reader', async route => {
    const response = await route.fetch();
    secondId = (await response.json()).spine[1];
    await route.fulfill({ response });
  });
  await page.route('**/readers/*/resources/*', async route => {
    if (secondId && route.request().url().endsWith(secondId)) {
      requests++;
      if (requests === 1) await first;
      if (requests === 2) await next;
    }
    await route.continue();
  });
  try {
    await signIn(page, app); await open(page, 'epub');
    await expect.poll(() => requests).toBe(1);
    await page.frameLocator('iframe').getByLabel('Contents').selectOption('1');
    releaseFirst();
    await expect.poll(() => requests).toBe(2);
    await page.getByLabel('Reading mode').selectOption('paged');
    releaseNext();
    await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Second section' })).toBeVisible();
    await expect(page.frameLocator('iframe').locator('article')).toHaveCount(1);
  } finally { releaseFirst(); releaseNext(); }
});

test('CBZ continuous scroll crosses real pages within a bounded decoded window', async ({ page, app }, info) => {
  await signIn(page, app);
  await open(page, 'cbz');
  const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
  await expect(page.getByRole('img', { name: 'Comic page 2 of 3', exact: true })).toBeAttached();
  await viewport.evaluate(element => {
    const next = element.querySelector<HTMLElement>('[data-page="2"]')!;
    element.scrollTop = next.offsetTop + 30;
  });
  await expect(page.getByLabel('Page number')).toHaveValue('2');
  expect(await viewport.locator('img').count()).toBeLessThanOrEqual(3);
  await capture(page, 'cbz-continuous-boundary', info);
  await page.getByLabel('Reading mode').selectOption('paged');
  await expect(page.getByLabel('Page number')).toHaveValue('2');
  await expect(viewport.locator('img')).toHaveCount(1);
});

test('EPUB continuous scroll crosses spine sections and paged advances a screen not a chapter', async ({ page, app }, info) => {
  await signIn(page, app);
  await open(page, 'epub');
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: 'Second section' })).toBeAttached();
  await frame.locator('#viewport').evaluate(element => {
    const host = document.getElementById('book')!;
    const sections = host.shadowRoot!.querySelectorAll<HTMLElement>('[data-section]');
    element.scrollTop += sections[1].getBoundingClientRect().top - element.getBoundingClientRect().top + 30;
  });
  await expect(frame.getByRole('status')).toContainText('Section 2 of');
  await capture(page, 'epub-continuous-boundary', info);
  await frame.getByLabel('Contents').selectOption('0');
  await page.getByLabel('Reading mode').selectOption('paged');
  await expect(frame.locator('article')).toHaveCount(1);
  await frame.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(frame.getByRole('status')).toContainText('Section 1 of');
  await expect.poll(() => frame.locator('#viewport').evaluate(element => element.scrollTop)).toBeGreaterThan(200);
});

for (const format of ['cbz', 'pdf', 'epub'] as const) test(`${format} denied native fullscreen is an explicit viewport-only fallback and Escape exits`, async ({ page, app }) => {
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = () => Promise.reject(new DOMException('Denied fixture', 'NotAllowedError'));
  });
  await signIn(page, app);
  await open(page, format);
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect(page.getByRole('status').getByText('Viewport-only view', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  if (format === 'epub') await page.frameLocator('iframe').locator('#viewport').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: 'Back to book' })).toBeVisible();
});
  for (const format of ['cbz', 'pdf', 'epub'] as const) {
    test(`${format} logical anchor survives mode fullscreen reflow and backend reopen`, async ({ page, app }, info) => {
      const writes: unknown[] = [];
      page.on('request', request => {
        if (request.method() === 'PUT' && request.url().endsWith('/progress/ebook')) writes.push(request.postDataJSON()?.locator);
      });
      await signIn(page, app);
      await open(page, format);
      const frame = page.frameLocator('iframe');
      const viewport = format === 'epub' ? frame.locator('#viewport') :
        page.getByRole('region', { name: format === 'cbz' ? 'Comic page' : 'PDF pages', exact: true });
      if (format === 'cbz') {
        await page.getByRole('button', { name: 'View options' }).click();
        await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('300');
        await page.getByRole('button', { name: 'View options' }).click();
        await viewport.evaluate(element => {
          const image = element.querySelector('img')!;
          element.scrollTop = (image.offsetHeight - element.clientHeight) * 0.6;
          element.scrollLeft = (element.scrollWidth - element.clientWidth) * 0.6;
        });
      } else if (format === 'pdf') {
        await page.getByLabel('Page number').fill('3'); await page.getByLabel('Page number').press('Enter');
        await expect(page.getByTestId('pdf-reader').getByRole('status')).toContainText('Page 3 of');
        await expect(page.getByText('Generated PDF page 3', { exact: true })).toBeVisible();
        await viewport.evaluate(element => {
          const target = element.querySelector<HTMLElement>('[data-page="3"]')!;
          element.scrollTop = target.offsetTop + target.offsetHeight * 0.25;
        });
      } else {
        await expect(frame.getByRole('heading', { name: 'Second section' })).toBeAttached();
        await viewport.evaluate(element => { element.scrollTop = 1800; });
      }
      await page.waitForTimeout(600);
      const layout = await viewport.evaluate(element => ({
        top: element.scrollTop, height: element.clientHeight, scrollHeight: element.scrollHeight,
        pages: [...element.querySelectorAll<HTMLElement>('[data-page]')].map(page => ({
          page: page.dataset.page, top: page.offsetTop, height: page.offsetHeight,
        })),
      }));
      const itemId = format === 'cbz' ? 'manga' : 'dual';
      const item = parseBookItem(await (await page.request.get(`${app.origin}/api/books/items/${itemId}`)).json());
      const file = item.files.find(file => file.extension === format)!;
      const progressUrl = `${app.origin}/api/books/items/${itemId}/progress/ebook?editionId=${file.fileId}`;
      const saved = async () => parseProgress((await (await page.request.get(progressUrl)).json()).progress).locator;
      // Leaving is a real save and allows an independent backend locator read.
      const leaving = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/progress/ebook'));
      await page.getByRole('link', { name: 'Back to book' }).click();
      await leaving;
      const before = await saved();
      await fs.writeFile(info.outputPath('anchor-debug.json'), JSON.stringify({ before, writes, layout }, null, 2));
      if (before.kind === 'cbz') expect(before.offset).toBeCloseTo(0.6, 2);
      if (before.kind === 'pdf') expect(before.offset).toBeCloseTo(0.25, 2);
      if (before.kind === 'epub') expect(before.textOffset).toBeGreaterThan(1000);
      if (format === 'pdf') await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
      await page.getByRole('link', { name: 'Read', exact: true }).click();
      await page.getByRole('button', { name: 'Resume saved position' }).click();
      await expect(viewport).toBeVisible();
      if (format === 'cbz') {
        await expect(viewport).toHaveAttribute('aria-busy', 'false');
        await expect(page.getByRole('img', { name: 'Comic page 1 of 3', exact: true })).toBeVisible();
      }
      for (const mode of ['paged', 'continuous', 'paged', 'continuous']) await page.getByLabel('Reading mode').selectOption(mode);
      await page.getByRole('button', { name: 'Full screen', exact: true }).click();
      await revealReaderControls(page);
      await page.getByRole('button', { name: 'Exit full screen' }).click();
      await page.setViewportSize({ width: page.viewportSize()!.width, height: 1100 });
      await page.waitForTimeout(400);
      const leavingAgain = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/progress/ebook'));
      await page.getByRole('link', { name: 'Back to book' }).click(); await leavingAgain;
      const after = await saved();
      await fs.writeFile(info.outputPath('anchor-debug.json'), JSON.stringify({ before, after, writes }, null, 2));
      expect(after).toMatchObject(before.kind === 'epub' ? { kind: 'epub', resourceId: before.resourceId, textOffset: before.textOffset } : { ...before });
      await app.restart(); await page.reload();
      if (format === 'pdf') await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
      await page.getByRole('link', { name: 'Read', exact: true }).click();
      await page.getByRole('button', { name: 'Resume saved position' }).click();
      await expect(viewport).toBeVisible();
      if (before.kind === 'cbz') {
        await page.getByRole('button', { name: 'View options' }).click();
        await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('300');
        await page.getByRole('button', { name: 'View options' }).click();
        await expect.poll(() => viewport.evaluate(element =>
          element.scrollTop / (element.querySelector('img')!.offsetHeight - element.clientHeight))).toBeCloseTo(0.6, 2);
      } else if (before.kind === 'pdf') {
        await expect.poll(() => viewport.evaluate((element, offset) => {
          const current = element.querySelector<HTMLElement>('[data-page="3"]');
          return current ? Math.abs(element.scrollTop - current.offsetTop - current.offsetHeight * offset) : 999;
        }, before.offset)).toBeLessThanOrEqual(1);
      } else if (before.kind === 'epub') {
        await expect.poll(() => frame.locator('[data-section="0"]').evaluate((element, textOffset) => {
          const article = element.shadowRoot!.querySelector('article')!;
          const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
          let remaining = textOffset, node: Node | null;
          while ((node = walker.nextNode())) {
            if (node.parentElement?.closest('style,script')) continue;
            if (remaining <= node.textContent!.length) {
              const range = document.createRange(); range.setStart(node, remaining); range.setEnd(node, Math.min(node.textContent!.length, remaining + 1));
              return Math.abs(range.getBoundingClientRect().top - document.getElementById('viewport')!.getBoundingClientRect().top);
            }
            remaining -= node.textContent!.length;
          }
          return 999;
        }, before.textOffset)).toBeLessThanOrEqual(2);
      }
      await capture(page, `${format}-anchor-reopened`, info);
      await fs.writeFile(info.outputPath(`${format}-anchors.json`), JSON.stringify({ before, after }, null, 2));
    });

    test(`${format} desktop and narrow touch swipes turn once while vertical touch scrolls`, async ({ page, app, browserName }, info) => {
      await signIn(page, app);
      await open(page, format);
      const frame = page.frameLocator('iframe');
      const viewport = format === 'epub' ? frame.locator('#viewport') :
        page.getByRole('region', { name: format === 'cbz' ? 'Comic page' : 'PDF pages', exact: true });
      const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined;
      const box = (await viewport.boundingBox())!;
      const from = { x: box.x + box.width * 0.65, y: box.y + box.height * 0.4 };
      const to = { x: box.x + box.width * 0.2, y: from.y };
      if (cdp) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 0, ...from }] });
        for (let step = 1; step <= 5; step++) await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove', touchPoints: [{ id: 0, x: from.x + (to.x - from.x) * step / 5, y: from.y }],
        });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await viewport.dispatchEvent('touchstart', { touches: [{ identifier: 0, clientX: from.x, clientY: from.y }] });
        await viewport.dispatchEvent('touchend', { touches: [], changedTouches: [{ identifier: 0, clientX: to.x, clientY: to.y }] });
      }
      if (format === 'epub') {
        await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(200);
        await expect(frame.getByRole('status')).toContainText('Section 1 of');
      } else await expect(page.getByLabel('Page number')).toHaveValue('2');
      const before = await viewport.evaluate(element => element.scrollTop);
      if (cdp) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 0, ...from }] });
        for (let step = 1; step <= 5; step++) await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove', touchPoints: [{ id: 0, x: from.x, y: from.y - step * 15 }],
        });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(before);
        await cdp.detach();
      }
      await capture(page, `${format}-touch`, info);
      await fs.writeFile(info.outputPath(`${format}-touch.json`), JSON.stringify({
        browserName, viewport: page.viewportSize(), source: cdp ? 'trusted Chromium CDP touch' : 'synthetic TouchEvent handler coverage',
        hardwareCertification: false, input: await page.evaluate(() => ({ maxTouchPoints: navigator.maxTouchPoints,
          coarse: matchMedia('(pointer: coarse)').matches })),
      }, null, 2));
    });
  }

test.describe('large bounded originals', () => {
  test.use({ readerWindowFixtures: true });
  test('CBZ mixed-width neighbors preserve canonical single-page horizontal fractions', async ({ page, app }) => {
    await signIn(page, app); await open(page, 'cbz');
    await expect(page.getByRole('img', { name: 'Comic page 2 of 3', exact: true })).toBeAttached();
    await page.getByRole('button', { name: 'View options' }).click();
    await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('300');
    await page.getByRole('button', { name: 'View options' }).click();
    const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
    await viewport.evaluate(element => {
      const first = element.querySelector<HTMLElement>('[data-page="1"]')!;
      element.scrollLeft = first.offsetLeft + (1440 - element.clientWidth) * 0.6;
    });
    await page.waitForTimeout(450);
    await page.getByLabel('Reading mode').selectOption('paged');
    await expect(viewport.locator('img')).toHaveCount(1);
    await expect.poll(() => viewport.evaluate(element =>
      element.scrollLeft / (element.scrollWidth - element.clientWidth))).toBeCloseTo(0.6, 2);
  });
  test('EPUB bounds long-section DOM and shared asset bytes while crossing twelve spine boundaries', async ({ page, app }, info) => {
    await signIn(page, app); await open(page, 'epub');
    const frame = page.frameLocator('iframe'), host = frame.locator('#book');
    const metrics: unknown[] = [];
    for (let index = 1; index <= 12; index++) {
      await expect(frame.locator(`[data-section="${index}"]`)).toBeAttached();
      await frame.locator('#viewport').evaluate((element, index) => {
        const section = document.getElementById('book')!.shadowRoot!.querySelector<HTMLElement>(`[data-section="${index}"]`)!;
        element.scrollTop += section.getBoundingClientRect().top - element.getBoundingClientRect().top + 50;
      }, index);
      await expect(frame.getByRole('status')).toContainText(`Section ${index + 1} of 24`);
      expect(await frame.locator('article').count()).toBeLessThanOrEqual(3);
      const metric = await host.evaluate(element => ({ ...element.dataset }));
      expect(Number(metric.assetBytes)).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(Number(metric.blobUrls)).toBeLessThanOrEqual(3);
      metrics.push(metric);
    }
    await capture(page, 'epub-large-window', info);
    await page.getByLabel('Reading mode').selectOption('paged');
    await expect(frame.locator('article')).toHaveCount(1);
    await fs.writeFile(info.outputPath('epub-window.json'), JSON.stringify(metrics, null, 2));
  });

  test('CBZ delayed neighbor cannot reset zoom or anchor and every blob is released on revocation', async ({ page, app }, info) => {
    await page.addInitScript(() => {
      const urls = new Set<string>(); let peak = 0;
      const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
      URL.createObjectURL = value => {
        const url = create(value); urls.add(url); peak = Math.max(peak, urls.size); return url;
      };
      URL.revokeObjectURL = url => { urls.delete(url); revoke(url); };
      Reflect.set(window, 'readerUrlMetrics', () => ({ live: urls.size, peak }));
    });
    let release!: () => void, held = false, count = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/readers/*/resources/*', async route => {
      if (++count === 2) { held = true; await gate; }
      await route.continue();
    });
    try {
      await signIn(page, app); await open(page, 'cbz');
      await expect.poll(() => held).toBe(true);
      await page.getByRole('button', { name: 'View options' }).click();
      await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('300');
      await page.getByRole('button', { name: 'View options' }).click();
      const image = page.getByRole('img', { name: 'Comic page 1 of 3', exact: true });
      await expect.poll(() => image.evaluate(element => element.getBoundingClientRect().width)).toBe(1440);
      const viewport = page.getByRole('region', { name: 'Comic page', exact: true });
      await viewport.evaluate(element => {
        element.scrollTop = (element.querySelector('img')!.offsetHeight - element.clientHeight) * 0.6;
      });
      await page.waitForTimeout(450);
      release();
      await expect(page.getByRole('img', { name: 'Comic page 2 of 3', exact: true })).toBeAttached();
      await expect.poll(() => image.evaluate(element => element.getBoundingClientRect().width)).toBe(1440);
      await expect.poll(() => viewport.evaluate(element =>
        element.scrollTop / (element.querySelector('img')!.offsetHeight - element.clientHeight))).toBeCloseTo(0.6, 2);
      const metrics = await page.evaluate(() => Reflect.get(window, 'readerUrlMetrics')());
      expect(metrics.peak).toBeLessThanOrEqual(3);
      expect(await viewport.locator('img').count()).toBeLessThanOrEqual(3);
      await page.evaluate(() => window.dispatchEvent(new Event('librarydownloadarr:books-changed')));
      await expect(viewport.locator('img')).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => Reflect.get(window, 'readerUrlMetrics')().live)).toBe(0);
      await fs.writeFile(info.outputPath('cbz-delayed-resource.json'), JSON.stringify(metrics, null, 2));
    } finally { release(); }
  });

  test('PDF bounds canvases cache and pixels across a 240 page original', async ({ page, app }, info) => {
    await signIn(page, app); await open(page, 'pdf');
    const reader = page.getByTestId('pdf-reader');
    for (const number of [20, 80, 150, 239]) {
      await page.getByLabel('Page number').fill(String(number)); await page.getByLabel('Page number').press('Enter');
      await expect(reader.getByRole('status')).toContainText(`Page ${number} of 240`);
      expect(await reader.locator('canvas').count()).toBeLessThanOrEqual(3);
      expect(Number(await reader.getAttribute('data-pdf-cached-bytes'))).toBeLessThanOrEqual(128 * 1024 * 1024);
      expect(Number(await reader.getAttribute('data-pdf-max-canvas-pixels'))).toBeLessThanOrEqual(16000000);
    }
    await capture(page, 'pdf-large-window', info);
    await fs.writeFile(info.outputPath('pdf-window.json'), JSON.stringify(await reader.evaluate(element => ({ ...element.dataset })), null, 2));
    await page.getByLabel('Reading mode').selectOption('paged');
    await expect(reader.locator('canvas')).toHaveCount(1);
  });
});
