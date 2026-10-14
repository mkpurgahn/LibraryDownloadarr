import fs from 'node:fs/promises';
import { test, expect, signIn, capture } from './harness';
import type { ReaderDescriptor } from '../../src/books/types';
import { parseBookItem } from '../../src/books/types';

test.describe('durable reader lifecycle', () => {
  test.use({ controlledReaderClock: true });
  test('unchanged_epub_resumes_after_handle_cache_and_backend_replacement', async ({ page, app }, info) => {
    await signIn(page, app);
    await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
    const firstPrepared = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/reader') && response.request().method() === 'POST');
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    const initial = await (await firstPrepared).json() as ReaderDescriptor;
    const frame = page.frameLocator('iframe[title="EPUB reader"]');
    await expect(frame.getByRole('heading', { name: 'First section' })).toBeVisible();
    await frame.getByRole('button', { name: 'Next section', exact: true }).click();
    await expect(frame.getByRole('heading', { name: 'Second section' })).toBeVisible();
    const saved = page.waitForResponse(response => response.request().method() === 'PUT' &&
      new URL(response.url()).pathname.endsWith('/progress/ebook') && response.request().postDataJSON()?.locator?.textOffset > 0);
    await frame.locator('#viewport').evaluate(element => { element.scrollTop = element.scrollHeight * 0.4; });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await saved;
    app.advanceReaderTime(31 * 60 * 1000);
    expect((await page.request.get(`${app.origin}/api/books/readers/${initial.readerId}/resources/${initial.spine[1]}`)).status()).toBe(410);
    await page.getByRole('link', { name: 'Back to book' }).click();
    await expect(page.getByRole('link', { name: 'Read', exact: true })).toBeVisible();
    const firstCache = await app.readerCache();
    const observations: object[] = [];
    for (const phase of ['handle-expiry', 'cache-expiry', 'backend-restart']) {
      if (phase === 'cache-expiry') app.advanceReaderTime(24 * 60 * 60 * 1000);
      else if (phase === 'backend-restart') {
        const previousInstance = app.instanceId;
        await app.restart();
        expect(app.instanceId).not.toBe(previousInstance);
        await page.reload();
        await expect(page.getByRole('link', { name: 'Read', exact: true })).toBeVisible();
      }
      const preparing = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/reader') && response.request().method() === 'POST');
      await page.getByRole('link', { name: 'Read', exact: true }).click();
      const descriptor = await (await preparing).json() as ReaderDescriptor;
      expect(descriptor.readerId).not.toBe(initial.readerId);
      expect(descriptor.contentVersion).toBe(initial.contentVersion);
      expect(descriptor.spine).toEqual(initial.spine);
      await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
      await expect(frame.getByRole('heading', { name: 'Second section' })).toBeAttached();
      await expect.poll(() => frame.locator('#viewport').evaluate(element => element.scrollTop / element.scrollHeight)).toBeGreaterThan(0.3);
      const cache = await app.readerCache();
      if (phase !== 'handle-expiry') expect(cache[0].createdAt).toBeGreaterThan(firstCache[0].createdAt);
      observations.push({ phase, contentVersion: descriptor.contentVersion, spineUnchanged: true, cache, instanceId: app.instanceId });
      await capture(page, `durable-epub-${phase}`, info);
      await page.getByRole('link', { name: 'Back to book' }).click();
      await expect(page.getByRole('link', { name: 'Read', exact: true })).toBeVisible();
    }
    await fs.writeFile(info.outputPath('reader-lifecycle.json'), JSON.stringify(observations, null, 2));
  });

  test('disable_books_revokes_only_books_and_retains_private_history', async ({ page, app, browserName }) => {
    test.skip(process.platform === 'win32' && browserName === 'webkit',
      'Positive active-audio revocation is covered on Linux WebKit; Windows codec fallback is tested separately.');
    await app.setAudio('m4b');
    await signIn(page, app, 2);
    await page.getByTestId('books-audio').evaluate(element => { if (element instanceof HTMLMediaElement) element.volume = 0; });
    await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
    await page.getByRole('button', { name: 'Listen', exact: true }).click();
    const player = page.getByRole('region', { name: 'Audiobook player' });
    await expect(async () => {
      const tap = player.getByRole('button', { name: 'Tap to resume' });
      if (await tap.isVisible()) await tap.click();
      expect(await page.getByTestId('books-audio').evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0.2);
    }).toPass({ timeout: 10000 });
    const item = parseBookItem(await (await page.request.get(`${app.origin}/api/books/items/dual`)).json());
    const previous = await (await page.request.get(`${app.origin}/api/books/items/dual/progress/audio?editionId=${item.audioEdition!.editionId}`)).json();
    const ticketResponse = await page.request.post(`${app.origin}/api/books/download-tickets`, {
      headers: { Authorization: `Bearer ${app.users[2].bearer}`, Origin: app.origin },
      data: { targets: [{ itemId: item.itemId, fileId: item.files[0].fileId, contentVersion: item.files[0].contentVersion }] },
    });
    const ticket = (await ticketResponse.json()).results[0].ticket.url;
    const oldBridge = (await page.context().cookies()).find(cookie => cookie.name === '__Secure-lda_books')!;
    const menu = page.getByRole('button', { name: 'Toggle menu' });
    if (await menu.isVisible()) await menu.click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Enable Books', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Save Books settings' }).click();
    await expect(page.getByText('Books settings saved', { exact: true })).toBeVisible();
    await expect(player).toHaveCount(0);
    await expect.poll(() => page.getByTestId('books-audio').evaluate(element => ({
      paused: (element as HTMLAudioElement).paused, src: element.getAttribute('src'),
    }))).toEqual({ paused: true, src: null });
    const bearerOnly = { Authorization: `Bearer ${app.users[2].bearer}`, Cookie: '' };
    expect((await page.request.get(`${app.origin}/api/libraries`, { headers: bearerOnly })).status()).toBe(200);
    expect((await page.request.get(`${app.origin}/api/media/season/123/download`, { headers: bearerOnly })).status()).toBe(410);
    expect((await page.request.get(`${app.origin}/api/books/items/dual`, { headers: bearerOnly })).status()).toBe(503);
    await page.getByLabel('Enable Books', { exact: true }).check();
    await page.getByLabel(/I verified this server binding/).check();
    await page.getByRole('button', { name: 'Save Books settings' }).click();
    await expect(page.getByText('Books settings saved', { exact: true })).toBeVisible();
    if (await menu.isVisible()) await menu.click();
    await expect(page.getByRole('button', { name: 'Books', exact: true })).toBeVisible();
    expect((await page.request.get(`${app.origin}${ticket}`, { headers: bearerOnly })).status()).toBe(410);
    expect((await page.request.get(`${app.origin}/api/books/items/dual`, {
      headers: { Cookie: `${oldBridge.name}=${oldBridge.value}` },
    })).status()).toBe(401);
    const retained = await (await page.request.get(`${app.origin}/api/books/items/dual/progress/audio?editionId=${item.audioEdition!.editionId}`, { headers: bearerOnly })).json();
    expect(retained.progress.key).toEqual(previous.progress.key);
    expect(retained.compatible).toBe(false);
  });
});
