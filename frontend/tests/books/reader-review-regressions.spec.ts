import fs from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, signIn, capture } from './harness';
import { parseBookItem, parseProgress } from '../../src/books/types';

test.use({ cbzFixtures: true, hasTouch: true });

async function open(page: Page, format: 'cbz' | 'pdf' | 'epub') {
  await page.getByRole('link', { name: format === 'cbz' ? 'Open The Paper Observatory' : 'Open A Tale in Two Formats', exact: true }).click();
  if (format === 'pdf') await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
}

test.describe('short continuous originals', () => {
  test.use({ shortReaderFixtures: true });
  for (const format of ['cbz', 'epub'] as const) {
    for (const fitPage of format === 'cbz' ? [false, true] : [false]) {
      test(`${format} short trailing entries remain scrollable in order and backwards${fitPage ? ' with Fit page' : ''}`, async ({ page, app }, info) => {
        await signIn(page, app); await open(page, format);
        const frame = page.frameLocator('iframe');
        const viewport = format === 'cbz' ? page.getByRole('region', { name: 'Comic page', exact: true }) : frame.locator('#viewport');
        const entries = format === 'cbz' ? viewport.locator('[data-page]') : frame.locator('[data-section]');
        const current = format === 'cbz' ? page.getByRole('region', { name: 'CBZ reader' }).getByRole('status').last() : frame.getByRole('status');
        await expect(current).toHaveText(format === 'cbz' ? 'Page 1 of 5' : 'Section 1 of 5');
        await expect(entries).toHaveCount(2);
        if (fitPage) {
          await page.getByRole('button', { name: 'View options' }).click();
          await page.getByRole('combobox', { name: 'Page fit', exact: true }).selectOption('page');
          await page.getByRole('button', { name: 'View options' }).click();
        }
        const metrics = async () => viewport.evaluate((element, format) => {
          const nodes = format === 'cbz' ? [...element.querySelectorAll<HTMLElement>('[data-page]')] :
            [...document.getElementById('book')!.shadowRoot!.querySelectorAll<HTMLElement>('[data-section]')];
          const top = element.getBoundingClientRect().top;
          return { top: element.scrollTop, height: element.clientHeight, scrollHeight: element.scrollHeight,
            entries: nodes.map(node => ({ number: Number(format === 'cbz' ? node.dataset.page : node.dataset.section) + (format === 'epub' ? 1 : 0),
              top: node.getBoundingClientRect().top - top, height: node.offsetHeight })),
            resources: format === 'cbz' ? { ...((element as HTMLElement).dataset) } : { ...document.getElementById('book')!.dataset } };
        }, format);
        const observed: unknown[] = [];
        try {
          const initial = await metrics(); observed.push(initial);
          expect(initial.entries[1].height).toBeLessThan(initial.height);
          if (format === 'epub') expect(initial.entries.reduce((sum, entry) => sum + entry.height, 0)).toBeLessThan(initial.height);
          await capture(page, `${format}-short-opening`, info);
          for (const number of [2, 3, 4, 5, 4, 3, 2, 1]) {
            const target = format === 'cbz' ? viewport.locator(`[data-page="${number}"]`) : frame.locator(`[data-section="${number - 1}"]`);
            await expect(target).toBeAttached();
            // Scroll only: no buttons, jumps, mode changes or synthetic scroll events.
            await viewport.evaluate((element, { format, number }) => {
              const target = format === 'cbz' ? element.querySelector<HTMLElement>(`[data-page="${number}"]`) :
                document.getElementById('book')!.shadowRoot!.querySelector<HTMLElement>(`[data-section="${number - 1}"]`);
              element.scrollTop += target!.getBoundingClientRect().top - element.getBoundingClientRect().top;
            }, { format, number });
            await expect(current).toHaveText(`${format === 'cbz' ? 'Page' : 'Section'} ${number} of 5`);
            const state = await metrics(); observed.push(state);
            expect(state.entries.length).toBeLessThanOrEqual(3);
            expect(state.entries.map(entry => entry.number)).toEqual([...state.entries.map(entry => entry.number)].sort((a, b) => a - b));
            expect(Math.abs(state.entries.find(entry => entry.number === number)!.top)).toBeLessThanOrEqual(2);
            if (format === 'cbz') {
              expect(Number(state.resources.decodedPixels)).toBeLessThanOrEqual(48000000);
              expect(Number(state.resources.pageBytes)).toBeLessThanOrEqual(96 * 1024 * 1024);
            } else expect(Number(state.resources.assetBytes)).toBeLessThanOrEqual(64 * 1024 * 1024);
            if (number === 5) {
              await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
              await expect(current).toHaveText(`${format === 'cbz' ? 'Page' : 'Section'} 5 of 5`);
              await capture(page, `${format}-short-final`, info);
            }
          }
          await capture(page, `${format}-short-returned`, info);
        } finally {
          observed.push(await metrics());
          await fs.writeFile(info.outputPath('short-window.json'), JSON.stringify(observed, null, 2));
          await capture(page, `${format}-short-outcome`, info);
        }
      });
    }
  }
});

for (const change of ['paged', 'fullscreen'] as const) {
  test(`PDF visible second-page anchor survives ${change} while third-page rendering waits`, async ({ page, app }, info) => {
    // Hold only PDF.js's real third-page acquisition. Pages one and two, ranges,
    // worker parsing, canvases and text rendering remain real.
    await page.addInitScript(() => {
      const OriginalWorker = window.Worker;
      let held = false, release: (() => void) | undefined;
      window.Worker = class extends OriginalWorker {
        override postMessage(message: unknown, transferOrOptions: Transferable[] | StructuredSerializeOptions = []) {
          const send = () => {
            if (Array.isArray(transferOrOptions)) super.postMessage(message, transferOrOptions);
            else super.postMessage(message, transferOrOptions);
          };
          const data = message as { action?: string; data?: { pageIndex?: number } };
          if (!held && data.action === 'GetPage' && data.data?.pageIndex === 2) { held = true; release = send; }
          else send();
        }
      };
      Reflect.set(window, 'thirdPageGate', { held: () => held, release: () => { release?.(); release = undefined; } });
    });
    const writes: unknown[] = [];
    page.on('request', request => {
      if (request.method() === 'PUT' && request.url().endsWith('/progress/ebook')) writes.push(request.postDataJSON()?.locator);
    });
    try {
      await signIn(page, app); await open(page, 'pdf');
      const viewport = page.getByRole('region', { name: 'PDF pages', exact: true });
      await expect(page.getByTestId('pdf-reader').getByRole('status')).toContainText('Page 1 of');
      await expect(viewport.locator('[data-page="2"] canvas')).toBeAttached();
      await viewport.evaluate(element => {
        const second = element.querySelector<HTMLElement>('[data-page="2"]')!;
        element.scrollTop = second.offsetTop + second.offsetHeight * 0.125;
      });
      await expect.poll(() => page.evaluate(() => Reflect.get(window, 'thirdPageGate').held())).toBe(true);
      await expect(page.getByText('Generated PDF page 2', { exact: true })).toBeAttached();
      await capture(page, 'pdf-visible-boundary-held', info);
      const heldState = await viewport.evaluate(element => ({
        top: element.scrollTop, pages: [...element.querySelectorAll<HTMLElement>('[data-page]')].map(page => ({
          page: page.dataset.page, top: page.offsetTop, height: page.offsetHeight,
        })),
      }));
      await fs.writeFile(info.outputPath('pdf-held-boundary.json'), JSON.stringify(heldState, null, 2));
      expect(heldState.pages.map(page => page.page)).toEqual(['1', '2']);
      expect(writes).not.toContainEqual(expect.objectContaining({ kind: 'pdf', page: 3 }));
      if (change === 'paged') await page.getByLabel('Reading mode').selectOption('paged');
      else {
        await page.getByRole('button', { name: 'Full screen', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Exit full screen', exact: true })).toBeVisible();
      }
      await page.evaluate(() => Reflect.get(window, 'thirdPageGate').release());
      await expect(page.getByTestId('pdf-reader').getByRole('status', { includeHidden: true })).toContainText('Page 2 of');
      const fraction = () => viewport.evaluate(element => {
        const second = element.querySelector<HTMLElement>('[data-page="2"]')!;
        return (element.scrollTop - second.offsetTop) / second.offsetHeight;
      });
      const overflow = await viewport.evaluate(element => element.scrollHeight > element.clientHeight);
      if (overflow) await expect.poll(fraction).toBeCloseTo(0.125, 2);
      else expect(await viewport.evaluate(element => element.scrollTop)).toBe(0);
      const reader = page.getByTestId('pdf-reader');
      if (change === 'paged') await expect(reader.locator('canvas')).toHaveCount(1);
      else expect(await reader.locator('canvas').count()).toBeLessThanOrEqual(3);
      expect(Number(await reader.getAttribute('data-pdf-cached-bytes'))).toBeLessThanOrEqual(128 * 1024 * 1024);
      expect(Number(await reader.getAttribute('data-pdf-max-canvas-pixels'))).toBeLessThanOrEqual(16000000);
      if (change === 'fullscreen') await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
      const item = parseBookItem(await (await page.request.get(`${app.origin}/api/books/items/dual`)).json());
      const file = item.files.find(file => file.extension === 'pdf')!;
      const savedResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/progress/ebook'));
      await page.getByRole('link', { name: 'Back to book' }).click(); await savedResponse;
      const durable = parseProgress((await (await page.request.get(`${app.origin}/api/books/items/dual/progress/ebook?editionId=${file.fileId}`)).json()).progress).locator;
      expect(durable).toMatchObject({ kind: 'pdf', page: 2 });
      if (durable.kind === 'pdf') expect(durable.offset).toBeCloseTo(0.125, 2);
      await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
      await page.getByRole('link', { name: 'Read', exact: true }).click();
      await page.getByRole('button', { name: 'Resume saved position' }).click();
      await expect(page.getByLabel('Page number')).toHaveValue('2');
      // A short Paged canvas can clamp physically; the saved fraction must return
      // when the continuous viewport has scroll space again.
      if (change === 'paged') await page.getByLabel('Reading mode').selectOption('continuous');
      await expect.poll(fraction).toBeCloseTo(0.125, 2);
      await fs.writeFile(info.outputPath('pdf-pending-anchor.json'), JSON.stringify({ heldState, durable, writes }, null, 2));
    } finally {
      await page.evaluate(() => Reflect.get(window, 'thirdPageGate')?.release());
      await capture(page, 'pdf-pending-outcome', info);
      await fs.writeFile(info.outputPath('pdf-pending-writes.json'), JSON.stringify(writes, null, 2));
    }
  });
}

test('EPUB fallback Escape from embedded navigation exits and restores trigger focus', async ({ page, app }, info) => {
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = () => Promise.reject(new DOMException('Denied fixture', 'NotAllowedError'));
  });
  await signIn(page, app); await open(page, 'epub');
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: 'First section' })).toBeVisible();
  await page.getByLabel('Reading mode').selectOption('paged');
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect(page.getByText('Viewport-only view', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show controls', exact: true }).click();
  const next = frame.getByRole('button', { name: 'Next page', exact: true });
  await next.focus(); await expect(next).toBeFocused();
  const top = await frame.locator('#viewport').evaluate(element => element.scrollTop);
  await page.keyboard.press('ArrowRight');
  expect(await frame.locator('#viewport').evaluate(element => element.scrollTop)).toBe(top);
  await capture(page, 'epub-embedded-control-focused', info);
  await page.keyboard.press('Escape');
  try {
    await expect(page.getByRole('button', { name: 'Exit full screen', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toBeFocused();
  } finally {
    await capture(page, 'epub-embedded-escape-outcome', info);
    await fs.writeFile(info.outputPath('escape-focus.json'), JSON.stringify({
      active: await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent })),
      fullscreen: await page.getByRole('button', { name: 'Exit full screen', exact: true }).count() > 0,
    }, null, 2));
  }
});

test('PDF Show controls uncovers the title without leaving fullscreen', async ({ page, app, browserName }, info) => {
  await signIn(page, app); await open(page, 'pdf');
  await expect(page.getByText('Generated PDF page 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Exit full screen', exact: true })).toBeVisible();
  await capture(page, 'pdf-fullscreen-controls-hidden', info);
  await page.getByRole('button', { name: 'Show controls', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'PDF controls' })).toBeVisible();
  const title = page.getByText('Generated PDF page 1', { exact: true });
  await expect(title).toBeInViewport();
  const titleBounds = (await title.boundingBox())!;
  const overlayBounds = (await page.getByRole('button', { name: 'Hide controls', exact: true }).boundingBox())!;
  expect(titleBounds.y).toBeGreaterThanOrEqual(overlayBounds.y + overlayBounds.height);
  await expect(page.getByRole('button', { name: 'Exit full screen', exact: true })).toBeVisible();
  const drawable = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, native: Boolean(document.fullscreenElement) }));
  await capture(page, 'pdf-fullscreen-title-unoccluded', info);
  await fs.writeFile(info.outputPath('fullscreen-unoccluded.json'), JSON.stringify({
    browserName, configured: page.viewportSize(), drawable, titleBounds, overlayBounds, headless: true,
  }, null, 2));
});
