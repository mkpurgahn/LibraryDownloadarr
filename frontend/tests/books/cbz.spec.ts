import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test, expect, signIn, capture, originalDownload } from './harness';

test.use({ cbzFixtures: true, controlledReaderClock: true, reverseProxy: true });

test('CBZ same-input detail and real numbered pages', async ({ page, app }, info) => {
  await signIn(page, app);
  await page.getByRole('link', { name: 'Open The Paper Observatory', exact: true }).click();
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
  await expect(page.getByRole('button', { name: 'Reading direction: right to left' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
  await capture(page, 'cbz-reader-page-1', info);
  await page.getByRole('region', { name: 'Comic page' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('img', { name: 'Comic page 2 of 3', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reading direction: right to left' }).click();
  await page.getByRole('region', { name: 'Comic page' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('img', { name: 'Comic page 3 of 3', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  await page.getByLabel('Page number', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Go to page', exact: true }).click();
  await expect(image).toBeVisible();
  await page.getByLabel('Page fit', { exact: true }).selectOption('width');
  await page.getByLabel('Zoom', { exact: true }).selectOption('200');
  await expect(page.getByRole('region', { name: 'Comic page' })).toHaveAttribute('data-decoded-pixels', '345600');
  await capture(page, 'cbz-reader-zoom', info);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('CBZ originals keep independent private progress across handles cache and backend restart', async ({ page, app }, info) => {
  await signIn(page, app);
  await page.getByRole('link', { name: 'Open The Paper Observatory', exact: true }).click();
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
  await signIn(page, app, 1);
  await page.getByRole('link', { name: 'Open The Paper Observatory', exact: true }).click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Comic page 1 of 3', exact: true })).toBeVisible();
});

test('CBZ corrupt pages fail honestly and original bytes still download unchanged', async ({ page, app }, info) => {
  await app.setCbz('corrupt');
  await signIn(page, app);
  await page.getByRole('link', { name: 'Open The Paper Observatory', exact: true }).click();
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
