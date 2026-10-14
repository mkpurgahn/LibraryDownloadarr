import { test, expect, signIn, capture, originalDownload } from './harness';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';

function luminance(rgb: number[]): number {
  const values = rgb.map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

test('dual_capability_item_is_one_card', async ({ page, app }, info) => {
  await signIn(page, app);
  await expect(page.getByRole('heading', { name: 'Books', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true })).toHaveCount(1);
  await page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A Tale in Two Formats', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Ebook original' })).toBeVisible();
  const selector = page.getByRole('combobox', { name: 'Ebook original' });
  const image = PNG.sync.read(await selector.screenshot());
  const pixel = (Math.floor(image.height / 2) * image.width + 8) * 4;
  const background = luminance([...image.data.subarray(pixel, pixel + 3)]);
  const foreground = luminance(await selector.evaluate(element =>
    (getComputedStyle(element).color.match(/\d+/g) ?? []).slice(0, 3).map(Number)));
  expect((Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)).toBeGreaterThanOrEqual(4.5);
  await expect(page.getByRole('link', { name: 'Read', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Listen', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Download original/ })).toHaveCount(4);
  await capture(page, 'dual-detail', info);
});

test('inventory_filters_are_not_codec_promises', async ({ page, app }, info) => {
  await signIn(page, app);
  const filter = page.getByRole('combobox', { name: 'Available sources' });
  await expect(filter.locator('option')).toHaveText(['All', 'Has ebook', 'Single-track audio', 'Multi-track audio']);
  await filter.selectOption('single');
  await expect(page.getByText('No books found', { exact: true })).toBeVisible();
  await filter.selectOption('ebook');
  await expect(page.getByRole('link', { name: 'Open Download-only Archive', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search books' }).fill('Two Formats');
  await page.getByRole('textbox', { name: 'Search books' }).press('Enter');
  await expect(page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page' })).toHaveCount(0);
  await capture(page, 'catalog-search', info);
});

test('books_keyboard_navigation_and_narrow_layout_are_usable', async ({ page, app }, info) => {
  await signIn(page, app);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'Search books' })).toBeFocused();
  await page.keyboard.type('Two Formats');
  await page.keyboard.press('Enter');
  const book = page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true });
  await expect(page.getByRole('button', { name: 'Clear search', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(1);
  await expect(book).toBeVisible();
  const focusTrace = [];
  for (let tab = 0; tab < 10 && !await book.evaluate(element => element === document.activeElement); tab++) {
    await page.keyboard.press('Tab');
    focusTrace.push(await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute('aria-label'),
      text: document.activeElement?.textContent?.slice(0, 100),
    })));
  }
  await fs.writeFile(info.outputPath('keyboard-state.json'), JSON.stringify(focusTrace, null, 2));
  await expect(book).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'A Tale in Two Formats', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('book_download_never_uses_plex_adapter', async ({ page, app }, info) => {
  const batches: number[] = [];
  let plexDownloads = 0;
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/books/download-tickets') {
      const body = request.postDataJSON() as { targets: unknown[] };
      batches.push(body.targets.length);
    }
    if (/^\/api\/media\/.*(?:download|burn|compatible|zip)/.test(pathname)) plexDownloads += 1;
  });
  await signIn(page, app);
  await page.getByRole('link', { name: 'Open One Hundred and One Tracks', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare all downloads' }).click();
  await expect.poll(() => batches).toEqual([100, 1]);
  expect(plexDownloads).toBe(0);
  await expect(page.getByText('Started', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Complete', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Save file', exact: true }).first()).toBeVisible();
  await capture(page, 'batch-handoff', info);
});

test('native_batch_is_started_not_complete', async ({ page, app }, info) => {
  await signIn(page, app);
  await page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true }).click();
  const file = await originalDownload(page, () => page.getByRole('button', { name: /Download original/ }).first().click(), info);
  await file.saveAs(info.outputPath('original.bin'));
  await expect(page.getByText('Started', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Save file', exact: true })).toBeVisible();
  const message = await page.getByText('Sent to your browser, not confirmed complete. If it was blocked, use Save file.', { exact: true }).boundingBox();
  const action = await page.getByRole('link', { name: 'Save file', exact: true }).boundingBox();
  expect(action!.height).toBeGreaterThanOrEqual(44);
  expect(action!.y).toBeGreaterThanOrEqual(message!.y + message!.height);
  await expect(page.getByText('Complete', { exact: true })).toHaveCount(0);
  await capture(page, 'native-handoff', info);
});

test('prepared_original_has_an_explicit_native_save_action', async ({ page, app }, info) => {
  await signIn(page, app);
  await page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true }).click();
  const first = await originalDownload(page, () => page.getByRole('button', { name: 'Prepare all downloads' }).click(), info);
  await first.saveAs(info.outputPath('first-original.bin'));
  const link = page.getByRole('link', { name: 'Save file', exact: true }).nth(1);
  await expect(link).toBeVisible();
  const download = page.waitForEvent('download', { timeout: 10000 });
  await link.click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('A Tale in Two Formats 2.pdf');
  await file.saveAs(info.outputPath('explicit-original.bin'));
});

test('user_change_clears_book_state', async ({ page, context, app }, info) => {
  await signIn(page, app);
  await page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true }).click();
  await page.getByRole('button', { name: /Download original/ }).first().click();
  await expect(page.getByRole('complementary', { name: 'Download activity' })).toBeVisible();
  const second = await context.newPage();
  await signIn(second, app, 1);
  await expect(page.getByRole('complementary', { name: 'Download activity' })).toHaveCount(0);
  await second.evaluate(() => { localStorage.removeItem('token'); });
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'A Tale in Two Formats', exact: true })).toHaveCount(0);
  await capture(page, 'logged-out', info);
});

test('books_outage_does_not_erase_plex_authentication', async ({ page, app }, info) => {
  await signIn(page, app);
  await expect(page.getByRole('heading', { name: 'Books', exact: true })).toBeVisible();
  app.setUnavailable(true);
  await page.getByRole('combobox', { name: 'Available sources' }).selectOption('ebook');
  await expect(page.getByRole('alert')).toContainText('Books');
  expect(await page.evaluate(() => Boolean(localStorage.getItem('token')))).toBe(true);
  await capture(page, 'provider-unavailable', info);
});

test('legacy_plex_queue_restores_without_persisting_books_tickets', async ({ page, app }) => {
  await signIn(page, app);
  await page.evaluate(async () => {
    const response = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    const { user } = await response.json() as { user: { id: string } };
    localStorage.setItem(`librarydownloadarr:burn-jobs:${user.id}`, JSON.stringify([{
      id: 'legacy-job', jobId: 'legacy-job', ratingKey: '42', partKey: '/library/parts/1/file.mp4',
      filename: 'Legacy Plex.mp4', title: 'Legacy Plex original', progress: 25,
      status: 'paused', mode: 'compatible', transfer: 'parallel',
    }]));
    localStorage.setItem(`librarydownloadarr:parallel:${user.id}:legacy-segment`, JSON.stringify({
      id: 'legacy-segment', userId: user.id, ratingKey: '43', partKey: '/library/parts/2/file.mp4',
      filename: 'Segmented Plex.mp4', title: 'Legacy segmented original', mode: 'original',
      etag: '"fixture-existing-validator"', totalBytes: 100,
      segments: [{ start: 0, end: 99, next: 25 }], lastModified: 1, updatedAt: 1,
    }));
  });
  await page.reload();
  await expect(page.getByText('Legacy Plex original', { exact: true })).toBeVisible();
  await expect(page.getByText('Legacy segmented original', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true }).click();
  await page.getByRole('button', { name: /Download original/ }).first().click();
  await expect(page.getByText('Started', { exact: true })).toBeVisible();
  const stored = await page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.startsWith('librarydownloadarr:burn-jobs:'))
    .map(key => JSON.parse(localStorage.getItem(key)!) as Array<{ id: string; source?: string }>));
  expect(stored.flat().map(row => row.id)).toEqual(['legacy-job']);
  expect(stored.flat().some(row => row.source === 'abs')).toBe(false);
  await page.getByRole('button', { name: 'Dismiss Books download', exact: true }).click();
  const checkpoint = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith('librarydownloadarr:parallel:'))!;
    return JSON.parse(localStorage.getItem(key)!) as { etag: string; segments: Array<{ next: number }> };
  });
  expect(checkpoint.etag).toBe('"fixture-existing-validator"');
  expect(checkpoint.segments[0].next).toBe(25);
});

test('owner_books_settings_exposes_status_not_credentials', async ({ page, app }, info) => {
  await signIn(page, app, 2);
  await page.goto(`${app.origin}/settings`);
  await expect(page.getByRole('heading', { name: 'Books connection' })).toBeVisible();
  await expect(page.getByLabel('ABS credential')).toHaveValue('');
  await page.getByRole('button', { name: 'Verify Books connection' }).click();
  await expect(page.getByText('Books connection verified', { exact: true })).toBeVisible();
  await capture(page, 'owner-settings', info);
});

test.describe('service worker', () => {
  test.use({ serviceWorkers: 'allow' });
  test.skip(({ browserName }) => browserName !== 'chromium', 'Service-worker cache proof is Chromium-specific');
  test('books_api_bypasses_existing_service_worker', async ({ page, app }) => {
    await signIn(page, app);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/service-worker.js');
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Books', exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
    await page.evaluate(async () => {
      const headers = { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' };
      const item = await (await fetch('/api/books/items/dual', { headers })).json() as {
        files: Array<{ fileId: string; role: string; extension: string; contentVersion: string }>;
      };
      const audio = item.files.find(file => file.role === 'audio')!;
      const pdf = item.files.find(file => file.extension === 'pdf')!;
      const content = await fetch(`/api/books/items/dual/files/${audio.fileId}/content?version=${audio.contentVersion}`, { headers });
      if (!content.ok) throw new Error('Protected fixture content unavailable');
      await content.arrayBuffer();
      const progress = await fetch('/api/books/items/dual/progress/ebook', {
        method: 'PUT', headers, body: JSON.stringify({
          editionId: pdf.fileId, op: 'claim', contentVersion: pdf.contentVersion, expectedRevision: 0,
          writerId: 'service-worker-fixture', sequence: 1, locator: { kind: 'pdf', page: 3, offset: 0.25 },
        }),
      });
      if (!progress.ok) throw new Error('Private fixture progress unavailable');
      await fetch(`/api/books/items/dual/progress/ebook?editionId=${pdf.fileId}`, { headers });
    });
    const second = await page.context().newPage();
    await signIn(second, app, 1);
    const cachedApi = await page.evaluate(async () => {
      const keys: string[] = [];
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName);
        for (const request of await cache.keys()) if (new URL(request.url).pathname.startsWith('/api/books')) keys.push(request.url);
      }
      return keys.length;
    });
    expect(cachedApi).toBe(0);
    const privatePosition = await second.evaluate(async () => {
      const headers = { Authorization: `Bearer ${localStorage.getItem('token')}` };
      const item = await (await fetch('/api/books/items/dual', { headers })).json() as { files: Array<{ fileId: string; extension: string }> };
      const file = item.files.find(file => file.extension === 'pdf')!;
      return (await (await fetch(`/api/books/items/dual/progress/ebook?editionId=${file.fileId}`, { headers })).json() as { progress: unknown }).progress;
    });
    expect(privatePosition).toBeNull();
  });
});

test.describe('actual ABS', () => {
  test.use({ liveProvider: true });
  test.skip(!process.env.BOOKS_TEST_ABS_ORIGIN, 'Independent ABS fixture must be supplied for acceptance');
  test('actual_abs_catalog_and_original_handoff', async ({ page, app }, info) => {
    const manifest = JSON.parse(await fs.readFile(process.env.BOOKS_FIXTURE_MANIFEST!, 'utf8')) as {
      files: Array<{ absItemId: string; absIno: string; relativePath: string; sha256: string }>;
    };
    const expected = manifest.files.find(file => file.relativePath.endsWith('/01.mp3'))!;
    await signIn(page, app);
    await page.getByRole('link', { name: 'Open LDA Dual Fixture', exact: true }).click();
    expect(new URL(page.url()).pathname).toBe(`/books/items/${expected.absItemId}`);
    await expect(page.getByRole('heading', { name: 'LDA Dual Fixture', exact: true })).toBeVisible();
    const download = await originalDownload(page, () => page.getByRole('button', { name: 'Download original 01.mp3', exact: true }).click(), info);
    const file = info.outputPath('actual-original.bin');
    await download.saveAs(file);
    expect(createHash('sha256').update(await fs.readFile(file)).digest('hex')).toBe(expected.sha256);
    await capture(page, 'actual-abs-detail', info);
  });
});
