import fs from 'node:fs/promises';
import { test, expect, signIn, capture } from './harness';
import { PDF_LIMITS, PdfCacheBudget } from '../../src/books/reader/pdfPolicy';
import type { Response } from '@playwright/test';

const savedPosition = (response: Response) => {
  if (!new URL(response.url()).pathname.endsWith('/progress/ebook') || response.request().method() !== 'PUT') return false;
  const body = response.request().postDataJSON();
  return body?.op === 'save' && body.locator?.kind === 'pdf' && body.locator.page === 3 &&
    body.locator.offset > 0.2 && body.locator.offset < 0.3;
};
type SavedPdf = { progress: { locator: { kind: 'pdf'; page: number; offset: number } } };

test('pdf_cache_and_source_limits_are_separate', () => {
  const budget = new PdfCacheBudget();
  const release = budget.reserve(128 * 1024 * 1024);
  expect(budget.used).toBe(128 * 1024 * 1024);
  expect(() => budget.reserve(1)).toThrow(/cache limit/);
  release(); release();
  expect(budget.used).toBe(0);
  expect(PDF_LIMITS.documentBytes).toBe(512 * 1024 * 1024);
  expect(PDF_LIMITS.pages).toBe(5000);
  expect(PDF_LIMITS.pagePixels).toBe(16000000);
});

test('pdf_range_render_and_resume', async ({ page, app }, info) => {
  const ranges: number[] = [];
  page.on('response', response => {
    if (new URL(response.url()).pathname.endsWith('/content') && response.request().headers().range) ranges.push(response.status());
  });
  await signIn(page, app);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('region', { name: 'PDF pages' })).toBeVisible();
  await expect(page.getByText('Generated PDF page 1', { exact: true })).toBeVisible();
  await page.getByLabel('Page number').fill('3');
  await page.getByLabel('Page number').press('Enter');
  await expect(page.getByLabel('Page number')).toHaveValue('3');
  await expect(page.getByTestId('pdf-reader').getByRole('status')).toContainText('Page 3 of');
  await page.getByLabel('Zoom').selectOption('1.5');
  await expect(page.getByText('Generated PDF page 3', { exact: true })).toBeVisible();
  expect(ranges.length).toBeGreaterThan(0);
  expect(ranges.every(status => status === 206)).toBe(true);
  const metrics = await page.getByTestId('pdf-reader').evaluate(element => {
    const canvas = element.shadowRoot!.querySelector<HTMLCanvasElement>('[data-page="3"] canvas')!;
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, Math.min(600, canvas.width), Math.min(360, canvas.height)).data;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 240) ink += 1;
    return {
      sourceBackingBytes: Number((element as HTMLElement).dataset.pdfSourceBackingBytes),
      peakCachedBytes: Number((element as HTMLElement).dataset.pdfPeakCachedBytes),
      renderedPages: Number((element as HTMLElement).dataset.pdfRenderedPages),
      renderedPixels: canvas.width * canvas.height, inkPixels: ink,
      engineOverhead: (element as HTMLElement).dataset.pdfEngineOverhead,
    };
  });
  expect(metrics.peakCachedBytes).toBeLessThanOrEqual(128 * 1024 * 1024);
  expect(metrics.renderedPixels).toBeLessThanOrEqual(16000000);
  expect(metrics.renderedPages).toBeLessThanOrEqual(3);
  expect(metrics.inkPixels).toBeGreaterThan(100);
  expect(metrics.sourceBackingBytes).toBeGreaterThan(0);
  expect(metrics.engineOverhead).toBe('not-measured');
  await fs.writeFile(info.outputPath('pdf-resources.json'), JSON.stringify({ ...metrics, ranges, headless: true, scope: 'app-managed cache; not total browser memory' }, null, 2));
  await capture(page, 'pdf-page-three', info);
  await page.getByRole('region', { name: 'PDF pages' }).evaluate(element => {
    const target = element.querySelector<HTMLElement>('[data-page="3"]')!;
    element.scrollTop = target.offsetTop + target.offsetHeight * 0.25;
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const savedWrite = page.waitForResponse(savedPosition);
  await page.getByRole('link', { name: 'Back to book' }).click();
  const saved = await (await savedWrite).json() as SavedPdf;
  expect(saved.progress.locator.kind).toBe('pdf');
  expect(saved.progress.locator.page).toBe(3);
  expect(saved.progress.locator.offset).toBeCloseTo(0.25, 2);
  await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  const resumedWrite = page.waitForResponse(savedPosition);
  await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
  await expect(page.getByLabel('Page number')).toHaveValue('3');
  await expect(page.getByText('Generated PDF page 3', { exact: true })).toBeVisible();
  const resumed = await (await resumedWrite).json() as SavedPdf;
  expect(resumed.progress.locator).toEqual(saved.progress.locator);
  const pixelError = await page.getByRole('region', { name: 'PDF pages' }).evaluate((element, offset) => {
    const target = element.querySelector<HTMLElement>('[data-page="3"]')!;
    return Math.abs(element.scrollTop - target.offsetTop - target.offsetHeight * offset);
  }, saved.progress.locator.offset);
  expect(pixelError).toBeLessThanOrEqual(1);
  await fs.writeFile(info.outputPath('pdf-resume.json'), JSON.stringify({
    saved: saved.progress.locator, resumed: resumed.progress.locator, cssPixelError: pixelError,
  }, null, 2));
});

test('pdf_active_content_is_inert', async ({ page, app }) => {
  const external: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== app.origin) external.push(url.origin);
  });
  await signIn(page, app);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByText('Generated PDF page 1', { exact: true })).toBeVisible();
  await expect(page.locator('embed,object,iframe,.annotationLayer,.xfaLayer')).toHaveCount(0);
  expect(await page.evaluate(() => 'pdfScriptExecuted' in window)).toBe(false);
  expect(external).toEqual([]);
});

test('pdf_scroll_advances_the_bounded_page_window', async ({ page, app }) => {
  await signIn(page, app);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByText('Generated PDF page 1', { exact: true })).toBeVisible();
  for (const number of [2, 3, 4]) {
    await page.getByRole('region', { name: 'PDF pages' }).evaluate((element, number) => {
      const target = element.querySelector<HTMLElement>(`[data-page="${number}"]`)!;
      element.scrollTop = target.offsetTop + 20;
    }, number);
    await expect(page.getByLabel('Page number')).toHaveValue(String(number));
  }
  await expect(page.getByTestId('pdf-reader').locator('.page')).toHaveCount(3);
  await expect(page.getByTestId('pdf-reader').locator('[data-page="1"]')).toHaveCount(0);
});

for (const mode of ['many-pages', 'corrupt', 'password'] as const) {
  test(`pdf_limits_reject_${mode}_without_a_plugin_or_password_prompt`, async ({ page, app }) => {
    app.setPdf(mode);
    await signIn(page, app);
    await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
    await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(/download the original/i);
    await expect(page.getByTestId('pdf-reader')).toHaveAttribute('data-pdf-worker-active', 'false');
    await expect(page.locator('embed,object,iframe,input[type="password"]')).toHaveCount(0);
  });
}

test('oversized_pdf_retains_download_but_allocates_no_worker', async ({ page, app }) => {
  app.setPdf('oversized');
  const contents: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/content')) contents.push(request.method()); });
  await signIn(page, app);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
  await expect(page.getByRole('button', { name: 'Read', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download original A Tale in Two Formats 2.pdf', exact: true })).toBeEnabled();
  expect(contents).toEqual([]);
  await expect(page.getByTestId('pdf-reader')).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to Books' }).click();
  await page.goto(`${app.origin}/audiobooks`);
  await page.getByRole('link', { name: 'Open One Hundred and One Tracks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveCount(0);
  await expect(page.getByText('This original exceeds the in-app reader size limit; download it below.')).toHaveCount(0);
});

test('pdf_cancellation_releases_the_owned_worker_and_pending_ranges', async ({ page, app }) => {
  let release: () => void = () => {};
  let requested: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { requested = resolve; });
  await page.route('**/api/books/items/**/content?*', async route => {
    if (route.request().method() === 'GET') { requested(); await held; await route.abort(); }
    else await route.continue();
  });
  await signIn(page, app);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await started;
  const previous = await page.getByTestId('pdf-reader').elementHandle();
  expect(previous).not.toBeNull();
  await page.getByRole('link', { name: 'Back to book' }).click();
  release();
  await expect.poll(() => previous!.evaluate(element => ({
    worker: element.dataset.pdfWorkerActive, source: element.dataset.pdfSourceBackingBytes, cache: element.dataset.pdfCachedBytes,
  }))).toEqual({ worker: 'false', source: '0', cache: '0' });
});

test('ignored_pdf_ranges_never_fall_back_to_a_second_full_document', async ({ page, app }) => {
  const requests: string[] = [];
  await page.route('**/api/books/items/**/content?*', async route => {
    if (route.request().method() === 'GET') {
      requests.push(route.request().headers().range ?? 'full');
      await route.fulfill({ status: 200, body: 'not a range', headers: { 'Content-Type': 'application/pdf' } });
    } else await route.continue();
  });
  await signIn(page, app);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('no longer supports safe ranges');
  expect(requests).toHaveLength(1);
  expect(requests).not.toContain('full');
  await expect(page.getByTestId('pdf-reader')).toHaveAttribute('data-pdf-source-backing-bytes', '0');
});

test('pdf_replacement_never_reuses_the_old_locator', async ({ page, app }) => {
  await signIn(page, app);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByText('Generated PDF page 1', { exact: true })).toBeVisible();
  app.setPdf('replacement');
  await page.reload();
  await expect(page.getByText('The original or reader policy changed.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume saved position' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start from beginning' }).click();
  await expect(page.getByText('Revised PDF page 1', { exact: true })).toBeVisible();
});

test('pdf_worker_failure_has_an_explicit_capability_fallback', async ({ page, app }) => {
  await page.route('**/assets/pdf.worker*.mjs', route => route.fulfill({
    status: 200, contentType: 'application/javascript', body: 'throw new Error("owned worker failure fixture");',
  }));
  await signIn(page, app);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('PDF worker is unavailable');
  await expect(page.getByTestId('pdf-reader')).toHaveAttribute('data-pdf-worker-active', 'false');
});

test('pdf_documents_in_other_tabs_remain_independent_and_private', async ({ page, browser, app }) => {
  await signIn(page, app);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByText('Generated PDF page 1', { exact: true })).toBeVisible();
  await page.getByLabel('Page number').fill('2');
  await page.getByLabel('Page number').press('Enter');
  await expect(page.getByLabel('Page number')).toHaveValue('2');
  await expect(page.getByTestId('pdf-reader').getByRole('status')).toContainText('Page 2 of');
  const context = await browser.newContext({ baseURL: app.origin, viewport: page.viewportSize(), ignoreHTTPSErrors: true });
  await context.route('**/*', route => new URL(route.request().url()).origin === app.origin ? route.continue() : route.abort());
  try {
    const other = await context.newPage();
    await signIn(other, app, 1);
    await other.getByRole('link', { name: 'A Tale in Two Formats' }).click();
    await other.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
    await other.getByRole('link', { name: 'Read', exact: true }).click();
    await expect(other.getByText('Generated PDF page 1', { exact: true })).toBeVisible();
    await expect(other.getByLabel('Page number')).toHaveValue('1');
    await expect(page.getByTestId('pdf-reader')).toHaveAttribute('data-pdf-worker-active', 'true');
    const old = await page.getByTestId('pdf-reader').elementHandle();
    await page.getByRole('link', { name: 'Back to book' }).click();
    await expect.poll(() => old!.evaluate(element => element.dataset.pdfWorkerActive)).toBe('false');
    await expect(other.getByTestId('pdf-reader')).toHaveAttribute('data-pdf-worker-active', 'true');
  } finally { await context.close(); }
});

test.describe('isolated ABS PDF', () => {
  test.use({ liveProvider: true });
  test.skip(!process.env.BOOKS_TEST_ABS_ORIGIN, 'Requires the retained isolated ABS consumer fixture.');
  test('real_pdf_renders_from_the_restricted_selected_library', async ({ page, app }, info) => {
    await signIn(page, app);
    await page.getByRole('link', { name: 'Open LDA PDF Fixture', exact: true }).click();
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await expect(page.getByRole('region', { name: 'PDF pages' })).toBeVisible();
    await expect(page.getByTestId('pdf-reader').locator('canvas')).toHaveCount(2);
    await expect(page.getByTestId('pdf-reader').locator('.textLayer')).toContainText(['LDA PDF', 'LDA PDF']);
    await page.getByLabel('Page number').fill('2');
    await page.getByLabel('Page number').press('Enter');
    await expect(page.getByLabel('Page number')).toHaveValue('2');
    await expect(page.getByTestId('pdf-reader').getByRole('status')).toContainText('Page 2 of');
    await capture(page, 'real-abs-pdf', info);
  });
});
