import fs from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect, capture, CbzTransfer } from './harness';
import { alignClock, domByteBound, ClockAlignment, DomFrame } from './cbzByteProof';

declare global {
  interface Window {
    cbzProof: { started: number; phaseId: number; delayMs: number; frames: Array<{ page: number; ms: number }>; unrenderedWrites: number[] };
    recordCbzFrame(page: number, ms: number, phaseId: number, epoch: number, deliveredEpoch: number): Promise<void>;
  }
}

test.use({ cbzFixtures: true, reverseProxy: true });

type ObservedFrame = DomFrame & { phase: string; receipt: ReturnType<CbzTransfer['snapshot']> };
async function observeFrames(page: Page, transfer: CbzTransfer, delayMs = 0): Promise<ObservedFrame[]> {
  const frames: ObservedFrame[] = [];
  await page.exposeFunction('recordCbzFrame', (page: number, ms: number, phaseId: number, epoch: number, deliveredEpoch: number) => {
    frames.push({ page, ms, phaseId, epoch, deliveredEpoch,
      phase: phaseId === 1 ? 'new' : phaseId === 2 ? 'resume' : `unknown-${phaseId}`, receipt: transfer.snapshot() });
  });
  await page.addInitScript(delayMs => {
    window.cbzProof = { started: 0, phaseId: 0, delayMs, frames: [], unrenderedWrites: [] };
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
      const epoch = performance.timeOrigin + performance.now(), phaseId = window.cbzProof.phaseId;
      window.cbzProof.frames.push({ page, ms });
      const deliver = () => { void window.recordCbzFrame(page, ms, phaseId, epoch, performance.timeOrigin + performance.now()); };
      if (window.cbzProof.delayMs) window.setTimeout(deliver, window.cbzProof.delayMs); else deliver();
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
  }, delayMs);
  return frames;
}
async function beginPhase(page: Page, transfer: CbzTransfer, phase: string): Promise<ClockAlignment[]> {
  const before = [await alignClock(page), await alignClock(page)];
  transfer.start({ phase });
  await page.evaluate(phaseId => { window.cbzProof.phaseId = phaseId; }, transfer.snapshot().phaseId);
  return before;
}
async function measureFrame(page: Page, transfer: CbzTransfer, frame: ObservedFrame, before: ClockAlignment[], info: TestInfo, name: string) {
  const alignment = [...before, await alignClock(page), await alignClock(page)];
  const timeline = transfer.timeline();
  const raw = { frame, alignment, timeline };
  const filename = info.outputPath(name + '.json');
  await fs.writeFile(filename, JSON.stringify({ ...raw, status: 'unvalidated' }, null, 2));
  let bound: ReturnType<typeof domByteBound>;
  try { bound = domByteBound(frame, frame.receipt, alignment, timeline); }
  catch (error) {
    await fs.writeFile(filename, JSON.stringify({ ...raw, status: 'inconclusive', error: String(error) }, null, 2));
    throw error;
  }
  await fs.writeFile(filename, JSON.stringify({ ...raw, status: 'valid', bound }, null, 2));
  return { ...frame, sourceBytes: bound.upperBytes, bound };
}

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
  const observed = await observeFrames(page, transfer);
  await page.goto(`${app.origin}/manifest.json`);
  await page.evaluate(token => localStorage.setItem('token', token), app.users[0].bearer);
  await page.goto(`${app.origin}/books/items/manga`);
  await expect(page.getByRole('link', { name: 'Read', exact: true })).toBeVisible();
  const initialClocks = await beginPhase(page, transfer, 'new');
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  const first = page.getByRole('img', { name: 'Comic page 1 of 243', exact: true });
  await first.waitFor({ timeout: 10000 });
  await expect.poll(() => observed.length).toBeGreaterThan(0);
  const initial = await measureFrame(page, transfer, observed[0], initialClocks, info, 'first-dom-observation');
  expect(await page.evaluate(() => window.cbzProof.started)).toBeGreaterThan(0);
  expect(initial.ms).toBeLessThanOrEqual(3000);
  expect(initial.sourceBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  const firstUrl = await first.getAttribute('src');
  await capture(page, 'progressive-first-page', info);
  await page.getByText('Preparing pages in the background: 10 of 243 ready.', { exact: true }).waitFor({ timeout: 10000 });
  const firstTen = transfer.snapshot();
  await fs.writeFile(info.outputPath('first-ten-observation.json'), JSON.stringify({ initial, firstTen, timeline: transfer.timeline() }, null, 2));
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
  const resumeClocks = await beginPhase(page, transfer, 'resume');
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
  await last.waitFor({ timeout: 10000 });
  await expect.poll(() => observed.some(f => f.phase === 'resume')).toBe(true);
  const resumed = await measureFrame(page, transfer, observed.find(f => f.phase === 'resume')!, resumeClocks, info, 'resume-dom-observation');
  const unrenderedWrites = await page.evaluate(() => window.cbzProof.unrenderedWrites);
  await fs.writeFile(info.outputPath('progressive-performance.json'), JSON.stringify({
    fixture: { pages: 243, archiveBytes: 180349307, rateBytesPerSecond: 8388608, middleHeld: true },
    frames: [initial, resumed], observed, firstTen, jumpMs, unrenderedWrites,
    qualification: 'Source-byte gates use conservative ALL-post-reset provider body bounds at the DOM event, including prior/abandoned traffic and whole boundary chunks. Receipt counters and clock uncertainty are retained. Not TCP wire, live-provider or physical-display timing; actual original not decoded.',
  }, null, 2));
  expect(resumed.page).toBe(243);
  expect(resumed.ms).toBeLessThanOrEqual(3000);
  expect(resumed.sourceBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(unrenderedWrites).toEqual([]);
  await capture(page, 'progressive-cold-resume-243', info);
});

test('delayed observer receipt cannot inflate the pre-DOM source-byte gate', async ({ page, app }, info) => {
  await app.setCbz('large');
  const transfer = app.cbzTransfer!;
  const observed = await observeFrames(page, transfer, 1250);
  await page.goto(`${app.origin}/manifest.json`);
  await page.evaluate(token => localStorage.setItem('token', token), app.users[0].bearer);
  await page.goto(`${app.origin}/books/items/manga`);
  await page.getByRole('link', { name: 'Read', exact: true }).waitFor();
  const before = await beginPhase(page, transfer, 'new');
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await page.getByRole('img', { name: 'Comic page 1 of 243', exact: true }).waitFor({ timeout: 10000 });
  await expect.poll(() => observed.length).toBeGreaterThan(0);
  const frame = await measureFrame(page, transfer, observed[0], before, info, 'delayed-dom-observation');
  expect(frame.deliveredEpoch - frame.epoch).toBeGreaterThanOrEqual(1250);
  expect(frame.receipt.bytes).toBeGreaterThan(4 * 1024 * 1024);
  expect(frame.ms).toBeLessThanOrEqual(3000);
  expect(frame.sourceBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
});

test('an indexed full-download fallback stays explicit and prioritizes a pending jump after that one transfer', async ({ page, app }, info) => {
  test.setTimeout(60000);
  await app.setCbz('large');
  const transfer = app.cbzTransfer!;
  await page.goto(`${app.origin}/manifest.json`);
  await page.evaluate(token => localStorage.setItem('token', token), app.users[0].bearer);
  await page.goto(`${app.origin}/books/items/manga`);
  transfer.start({ ignoreEntryRanges: true });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('region', { name: 'CBZ reader', exact: true })).toBeVisible();
  await expect(page.getByText('This source requires a full download before pages can be prepared.', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /Comic page/ })).toHaveCount(0);
  await page.getByLabel('Page number', { exact: true }).fill('243');
  await page.getByRole('button', { name: 'Go to page', exact: true }).click();
  await capture(page, 'indexed-full-download-fallback', info);
  transfer.release();
  await expect(page.getByRole('img', { name: 'Comic page 243 of 243', exact: true })).toBeVisible({ timeout: 30000 });
  expect(transfer.snapshot().requests).toBe(3);
  expect(transfer.snapshot().bytes).toBeGreaterThanOrEqual(180349307);
  await capture(page, 'full-download-fallback-requested-page', info);
});
