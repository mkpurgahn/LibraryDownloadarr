import fs from 'node:fs/promises';
import { test, expect, signIn, capture } from './harness';
import type { ReaderDescriptor } from '../../src/books/types';

test('first_open_waits_for_initial_claim_without_false_resume_choices', async ({ page, app }, info) => {
  await signIn(page, app);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  let entered!: () => void; let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let hold = true;
  await page.route('**/progress/ebook', async route => {
    if (hold && route.request().method() === 'PUT' && route.request().postDataJSON()?.op === 'claim') {
      hold = false; entered(); await held;
    }
    await route.continue();
  });
  try {
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await waiting;
    await expect(page.getByText('Preparing book...', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Saved position' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start from beginning' })).toHaveCount(0);
    await expect(page.getByText('A private saved position is available.', { exact: true })).toHaveCount(0);
    release();
    const frame = page.frameLocator('iframe[title="EPUB reader"]');
    await expect(frame.getByRole('heading', { name: 'First section' })).toBeVisible();
    await frame.getByRole('button', { name: 'Next section', exact: true }).click();
    await expect(frame.getByRole('heading', { name: 'Second section' })).toBeVisible();
    await page.getByRole('link', { name: 'Back to book' }).click();
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    await page.getByRole('button', { name: 'Resume saved position' }).click();
    await expect(frame.getByRole('heading', { name: 'Second section' })).toBeVisible();
    await capture(page, 'first-open-and-genuine-resume', info);
  } finally { release(); }
});

test('first_claim_network_failure_recovers_without_false_saved_position', async ({ page, app }) => {
  await signIn(page, app);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  let fail = true;
  await page.route('**/progress/ebook', async route => {
    if (fail && route.request().method() === 'PUT') {
      fail = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"ABS_UNAVAILABLE","error":"Fixture unavailable"}' });
    } else await route.continue();
  });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('A private saved position is available.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open reader again' }).click();
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'First section' })).toBeVisible();
});

test.describe('accurate long-node lifecycle', () => {
  test.use({ longNodeEpub: true, controlledReaderClock: true });
  test('long_single_node_resumes_near_same_text_after_reflow_and_replacement', async ({ page, app }, info) => {
    await signIn(page, app);
    await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
    const prepared = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/reader') && response.request().method() === 'POST');
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    const initial = await (await prepared).json() as ReaderDescriptor;
    const frame = page.frameLocator('iframe[title="EPUB reader"]');
    await expect(frame.locator('article p')).toBeVisible();
    expect(await frame.locator('article p').evaluate(element => ({
      nodes: element.childNodes.length, textNode: element.firstChild?.nodeType === Node.TEXT_NODE,
    }))).toEqual({ nodes: 1, textNode: true });
    const targetToken = 350;
    await frame.locator('article p').evaluate((element, token) => {
      const text = element.firstChild!;
      const offset = text.textContent!.indexOf(`Token${String(token).padStart(5, '0')}`);
      const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1);
      const viewport = document.getElementById('viewport')!;
      viewport.scrollTop += range.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    }, targetToken);
    const visibleToken = () => frame.locator('article p').evaluate(element => {
      const node = element.firstChild!;
      const top = document.getElementById('viewport')!.getBoundingClientRect().top;
      const text = node.textContent!;
      for (const match of text.matchAll(/Token(\d{5})/g)) {
        const range = document.createRange(); range.setStart(node, match.index!); range.setEnd(node, match.index! + 10);
        const rect = range.getBoundingClientRect();
        if (rect.top >= top - 1) return Number(match[1]);
      }
      return -1;
    });
    await expect.poll(visibleToken).toBeGreaterThanOrEqual(targetToken - 1);
    const observations: object[] = [];
    observations.push({ phase: 'initial', visibleToken: await visibleToken(), targetToken });
    for (const size of ['24', '16', '20']) {
      const saving = page.waitForResponse(response => response.request().method() === 'PUT' &&
        new URL(response.url()).pathname.endsWith('/progress/ebook') && response.request().postDataJSON()?.locator?.textOffset > 0);
      await frame.getByLabel('Font size').selectOption(size);
      const progress = await (await saving).json();
      const geometry = await frame.locator('article p').evaluate((element, offset) => {
        const viewport = document.getElementById('viewport')!;
        const range = document.createRange();
        range.setStart(element.firstChild!, offset); range.setEnd(element.firstChild!, offset + 1);
        return { scroll: viewport.scrollTop, viewportTop: viewport.getBoundingClientRect().top,
          savedCharacterTop: range.getBoundingClientRect().top, savedText: element.textContent!.slice(offset, offset + 100) };
      }, progress.progress.locator.textOffset);
      observations.push({ phase: `font-${size}`, visibleToken: await visibleToken(), targetToken, saved: progress.progress.locator, geometry });
      await fs.writeFile(info.outputPath('long-node-lifecycle.json'), JSON.stringify(observations, null, 2));
      await expect.poll(async () => Math.abs(await visibleToken() - targetToken)).toBeLessThanOrEqual(2);
    }
    const firstCache = await app.readerCache();
    let currentHandle = initial;
    for (const phase of ['reopen', 'handle-expiry', 'cache-expiry', 'backend-restart']) {
      if (phase === 'handle-expiry') {
        app.advanceReaderTime(31 * 60 * 1000);
        expect((await page.request.get(`${app.origin}/api/books/readers/${currentHandle.readerId}/resources/${currentHandle.spine[0]}`)).status()).toBe(410);
      }
      await page.getByRole('link', { name: 'Back to book' }).click();
      await expect(page.getByRole('link', { name: 'Read', exact: true })).toBeVisible();
      if (phase === 'cache-expiry') app.advanceReaderTime(24 * 60 * 60 * 1000);
      if (phase === 'backend-restart') {
        const previous = app.instanceId;
        await app.restart(); expect(app.instanceId).not.toBe(previous);
        await page.reload();
      }
      await expect(page.getByRole('link', { name: 'Read', exact: true })).toBeVisible();
      const preparing = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/reader') && response.request().method() === 'POST');
      await page.getByRole('link', { name: 'Read', exact: true }).click();
      const next = await (await preparing).json() as ReaderDescriptor;
      currentHandle = next;
      expect(next.readerId).not.toBe(initial.readerId);
      expect(next.contentVersion).toBe(initial.contentVersion); expect(next.spine).toEqual(initial.spine);
      await page.getByRole('button', { name: 'Resume saved position' }).click();
      await expect.poll(async () => Math.abs(await visibleToken() - targetToken)).toBeLessThanOrEqual(2);
      const cache = await app.readerCache();
      if (phase === 'cache-expiry' || phase === 'backend-restart') expect(cache[0].createdAt).toBeGreaterThan(firstCache[0].createdAt);
      observations.push({ phase, visibleToken: await visibleToken(), targetToken, cache, instanceId: app.instanceId });
      await capture(page, `long-node-${phase}`, info);
    }
    await page.getByRole('link', { name: 'Back to book' }).click();
    await fs.writeFile(info.outputPath('long-node-lifecycle.json'), JSON.stringify(observations, null, 2));
  });
});
