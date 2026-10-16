import fs from 'node:fs/promises';
import { test, expect } from './harness';
import { parseBookItem, parseProgress, parseProgressiveComic } from '../../src/books/types';

test.use({ cbzFixtures: true, reverseProxy: true });

test('a held initial claim cannot rewind the rendered page on leave and durable reopen', async ({ page, app }, info) => {
  await page.goto(`${app.origin}/manifest.json`);
  await page.evaluate(token => localStorage.setItem('token', token), app.users[0].bearer);
  await page.goto(`${app.origin}/books/items/manga`);
  await expect(page.getByRole('link', { name: 'Read', exact: true })).toBeVisible();
  const item = parseBookItem(await (await page.request.get(`${app.origin}/api/books/items/manga`)).json());
  const editionId = item.files[0].fileId;
  const progressUrl = `${app.origin}/api/books/items/manga/progress/ebook?editionId=${editionId}`;
  const savedPage = async () => {
    const response = await page.request.get(progressUrl);
    expect(response.status()).toBe(200);
    return parseProgress((await response.json()).progress).locator;
  };
  let release!: () => void;
  let held = false;
  const released = new Promise<void>(resolve => { release = resolve; });
  const writes: Array<{ op: string; page: number }> = [];
  await page.route('**/progress/ebook', async route => {
    const request = route.request();
    if (request.method() !== 'PUT') return route.continue();
    const write = request.postDataJSON();
    writes.push({ op: write.op, page: write.locator.page });
    if (write.op !== 'claim' || held) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    expect((await response.json()).progress.locator.page).toBe(1);
    held = true;
    await released;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await expect(page.getByRole('img', { name: 'Comic page 1 of 3', exact: true })).toBeVisible();
    await expect.poll(() => held).toBe(true);
    await expect(page.getByRole('region', { name: 'Comic page', exact: true })).toHaveAttribute('aria-busy', 'false');
    await page.getByLabel('Page number').fill('2');
    await page.getByRole('button', { name: 'Go to page', exact: true }).click();
    const second = page.getByRole('img', { name: 'Comic page 2 of 3', exact: true });
    await expect(second).toBeVisible();
    await expect.poll(() => second.evaluate(image => image instanceof HTMLImageElement && image.naturalWidth)).toBe(480);
    await page.getByLabel('Reading mode').selectOption('paged');
    await page.getByLabel('Reading mode').selectOption('continuous');
    // Finish layout, then hold periodic/animation sampling through claim acknowledgement and cleanup.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const clockStart = Date.now();
    await page.clock.install({ time: clockStart });
    await page.clock.pauseAt(clockStart + 1000);
    const saved = page.waitForResponse(response => response.request().method() === 'PUT' &&
      response.url().endsWith('/progress/ebook') && response.status() === 200 &&
      response.request().postDataJSON().op === 'save' && response.request().postDataJSON().locator.page === 2);
    release();
    expect((await (await saved).json()).progress.locator.page).toBe(2);
    expect(await savedPage()).toMatchObject({ kind: 'cbz', page: 2 });
    const releasedReader = page.waitForResponse(response => response.request().method() === 'DELETE' &&
      /\/readers\/[^/]+$/.test(new URL(response.url()).pathname) && response.status() === 204);
    await page.getByRole('link', { name: 'Back to book', exact: true }).evaluate(link => (link as HTMLAnchorElement).click());
    await releasedReader;
    const durable = await savedPage();
    await fs.writeFile(info.outputPath('held-claim.json'), JSON.stringify({ writes, durable }, null, 2));
    expect.soft(durable).toMatchObject({ kind: 'cbz', page: 2 });
    await page.clock.resume();
    await app.restart();
    await page.reload();
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
    await expect(second).toBeVisible();
    expect(await savedPage()).toMatchObject({ kind: 'cbz', page: 2 });
  } finally { release(); }
});

test('accepted progressive start never retries legacy preparation after a pre-index status404', async ({ page, app }, info) => {
  await page.goto(`${app.origin}/manifest.json`);
  await page.evaluate(token => localStorage.setItem('token', token), app.users[0].bearer);
  await page.goto(`${app.origin}/books/items/manga`);
  let legacyStarts = 0;
  let statusCode = 0;
  let statusBody: unknown;
  await page.route('**/reader', async route => {
    legacyStarts++;
    await route.abort();
  });
  await page.route('**/reader-progressive', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    const start = parseProgressiveComic(await response.json());
    expect(start.spine).toEqual([]);
    // Remove the real accepted handle before its first status response, as pre-index expiry does.
    const removed = await page.request.delete(`${app.origin}/api/books/readers/${start.readerId}`, {
      headers: { Authorization: `Bearer ${app.users[0].bearer}`, Origin: app.origin },
    });
    expect(removed.status()).toBe(204);
    await expect.poll(() => app.readerCache()).toEqual([]);
    await route.fulfill({ response });
  });
  await page.route('**/readers/*/status?*', async route => {
    const response = await route.fetch();
    statusCode = response.status();
    statusBody = await response.json();
    expect(response.headers()['x-book-reader-protocol']).toBeUndefined();
    await route.fulfill({ response });
  });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open reader again', exact: true })).toBeVisible();
  await fs.writeFile(info.outputPath('expired-start.json'), JSON.stringify({ statusCode, statusBody, legacyStarts }, null, 2));
  expect(statusCode).toBe(404);
  expect(statusBody).toMatchObject({ code: 'BOOK_NOT_FOUND' });
  expect(legacyStarts, 'An accepted progressive attempt must not acquire fresh legacy budgets').toBe(0);
  await expect(page.getByRole('img', { name: /Comic page/ })).toHaveCount(0);
});
