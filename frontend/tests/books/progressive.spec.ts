import fs from 'node:fs/promises';
import { test, expect, capture } from './harness';

declare global {
  interface Window {
    cbzProof: { started: number; frames: Array<{ page: number; ms: number }>; unrenderedWrites: number[] };
    recordCbzFrame(page: number, ms: number): Promise<void>;
  }
}

test.use({ cbzFixtures: true, reverseProxy: true });

test('CBZ Read loads private progress before the opt-in progressive start and renders a decoded page', async ({ page, app }) => {
  await page.goto(`${app.origin}/manifest.json`);
  await page.evaluate(token => localStorage.setItem('token', token), app.users[0].bearer);
  await page.goto(`${app.origin}/books/items/manga`);
  await expect(page.getByRole('link', { name: 'Read', exact: true })).toBeVisible();
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/books/')) requests.push(request.url()); });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Comic page 1 of 3', exact: true })).toBeVisible();
  const start = requests.findIndex(url => url.endsWith('/reader-progressive'));
  const progress = requests.findIndex(url => url.includes('/progress/ebook?'));
  expect(start, 'Read must opt into the partial protocol, not await whole-archive preparation').toBeGreaterThanOrEqual(0);
  expect(progress).toBeGreaterThanOrEqual(0);
  expect(progress).toBeLessThan(start);
});

test('throttled243page source opens ten pages, jumps past held work and cold-resumes before whole transfer', async ({ page, app }, info) => {
  test.setTimeout(60000);
  await app.setCbz('large');
  const transfer = app.cbzTransfer!;
  const frames: Array<{ page: number; ms: number; phase: string; sourceBytes: number }> = [];
  let phase = 'new';
  await page.exposeFunction('recordCbzFrame', (page: number, ms: number) => {
    frames.push({ page, ms, phase, sourceBytes: transfer.snapshot().bytes });
  });
  await page.addInitScript(() => {
    window.cbzProof = { started: 0, frames: [], unrenderedWrites: [] };
    const rendered = new Set<number>();
    document.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('a')?.textContent?.trim() === 'Read') {
        window.cbzProof.started = performance.now();
        rendered.clear();
      }
    }, true);
    let previousImage: HTMLImageElement | undefined;
    new MutationObserver(() => {
      const image = document.querySelector<HTMLImageElement>('img[alt^="Comic page "]');
      if (!image?.naturalWidth) return;
      const page = Number(image.alt.match(/^Comic page (\d+)/)?.[1]);
      rendered.add(page);
      if (previousImage === image) return;
      previousImage = image;
      const ms = performance.now() - window.cbzProof.started;
      window.cbzProof.frames.push({ page, ms });
      void window.recordCbzFrame(page, ms);
    }).observe(document, { subtree: true, childList: true });
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (init?.method === 'PUT' && typeof init.body === 'string' && String(input).includes('/progress/ebook')) {
        const body = JSON.parse(init.body);
        if (body.locator?.kind === 'cbz' && !rendered.has(body.locator.page) &&
            !document.querySelector<HTMLImageElement>(`img[alt="Comic page ${body.locator.page} of 243"]`)?.naturalWidth) {
          window.cbzProof.unrenderedWrites.push(body.locator.page);
        }
      }
      return original(input, init);
    };
  });
  await page.goto(`${app.origin}/manifest.json`);
  await page.evaluate(token => localStorage.setItem('token', token), app.users[0].bearer);
  await page.goto(`${app.origin}/books/items/manga`);
  await expect(page.getByRole('link', { name: 'Read', exact: true })).toBeVisible();
  transfer.start();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  const first = page.getByRole('img', { name: 'Comic page 1 of 243', exact: true });
  await expect(first).toBeVisible({ timeout: 3000 });
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.cbzProof.started)).toBeGreaterThan(0);
  expect(frames[0].ms).toBeLessThanOrEqual(3000);
  expect(frames[0].sourceBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  const firstUrl = await first.getAttribute('src');
  await capture(page, 'progressive-first-page', info);
  await expect(page.getByText('Preparing pages in the background: 10 of 243 ready.', { exact: true })).toBeVisible({ timeout: 5000 });
  const firstTen = transfer.snapshot();
  await fs.writeFile(info.outputPath('first-ten-observation.json'), JSON.stringify({ frames, firstTen }, null, 2));
  expect(firstTen.bytes).toBeLessThanOrEqual(12 * 1024 * 1024);
  expect(firstTen.elapsedMs).toBeLessThanOrEqual(5000);
  expect(firstTen.held).toBe(true);
  expect(await first.getAttribute('src')).toBe(firstUrl);
  await capture(page, 'progressive-ten-ready', info);
  await page.getByLabel('Page number', { exact: true }).fill('243');
  const jumpedAt = performance.now();
  await page.getByRole('button', { name: 'Go to page', exact: true }).click();
  const last = page.getByRole('img', { name: 'Comic page 243 of 243', exact: true });
  await expect(last).toBeVisible({ timeout: 3000 });
  const jumpMs = performance.now() - jumpedAt;
  await expect(page.getByText('Position saved', { exact: true })).toBeVisible();
  await capture(page, 'progressive-jump-243', info);
  await page.getByRole('link', { name: 'Back to book', exact: true }).click();
  await expect.poll(() => transfer.snapshot().active).toBe(0);
  await expect.poll(() => app.readerCache()).toEqual([]);
  transfer.start(); phase = 'resume';
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
  await expect(last).toBeVisible({ timeout: 3000 });
  await expect.poll(() => frames.some(f => f.phase === 'resume')).toBe(true);
  const resumed = frames.find(f => f.phase === 'resume')!;
  expect(resumed.page).toBe(243);
  expect(resumed.ms).toBeLessThanOrEqual(3000);
  expect(resumed.sourceBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(await page.evaluate(() => window.cbzProof.unrenderedWrites)).toEqual([]);
  await capture(page, 'progressive-cold-resume-243', info);
  await fs.writeFile(info.outputPath('progressive-performance.json'), JSON.stringify({
    fixture: { pages: 243, archiveBytes: 180349307, rateBytesPerSecond: 8388608, middleHeld: true },
    frames, firstTen, jumpMs, qualification: 'Generated headless DOM-decoded timings; provider body bytes sent are an upper bound, not TCP wire or physical-display timings. Actual original not decoded.',
  }, null, 2));
});
