import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, signIn, capture, repoRoot } from './harness';
import { BookFile, parseBookItem, record, list } from '../../src/books/types';
import type { BooksApp } from './harness';
import type { Page } from '@playwright/test';

async function managedDual(page: Page, app: BooksApp) {
  const source = process.env.BOOKS_FIXTURE_MANIFEST;
  if (!source || !path.isAbsolute(source) || path.relative(repoRoot, source).startsWith('..')) throw new Error('Execution-root handoff required');
  const bytes = await fs.readFile(source);
  const { normalizeFixtureManifest } = await import('../../../backend/dist/books/proof/verifyAbs.js');
  const manifest = normalizeFixtureManifest(JSON.parse(bytes.toString('utf8')));
  const ebook = manifest.files.find(file => file.relativePath.endsWith('.epub') &&
    manifest.files.filter(other => other.absItemId === file.absItemId && other.role === 'audio').length === 2 &&
    manifest.files.filter(other => other.absItemId === file.absItemId && other.role === 'audio').every(other => other.relativePath.endsWith('.mp3')));
  if (!ebook) throw new Error('Frozen dual-format handoff item required');
  await signIn(page, app);
  await expect(page.getByRole('link', { name: /^Open / }).first()).toBeVisible();
  const response = await page.request.get(`${app.origin}/api/books/items/${ebook.absItemId}`);
  const item = parseBookItem(await response.json());
  expect(item.libraryId).toBe(manifest.libraryId);
  expect(item.providerInstanceId).toBe(app.binding?.providerInstanceId);
  await page.goto(`${app.origin}/books/items/${item.itemId}`);
  await expect(page.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
  return { item, ebook, manifest, handoffSha256: createHash('sha256').update(bytes).digest('hex') };
}

test.describe('frozen managed consumer', () => {
  test.use({ externalApp: true });
  test.skip(!process.env.BOOKS_TEST_URL, 'Requires the explicitly configured isolated candidate and protected session file.');
  test('handoff_identities_and_small_originals_match_the_candidate', async ({ page, app }, info) => {
    const file = process.env.BOOKS_FIXTURE_MANIFEST;
    if (!file || !path.isAbsolute(file) || path.relative(repoRoot, file).startsWith('..')) throw new Error('Execution-root handoff input required');
    const bytes = await fs.readFile(file);
    const { normalizeFixtureManifest } = await import('../../../backend/dist/books/proof/verifyAbs.js');
    const manifest = normalizeFixtureManifest(JSON.parse(bytes.toString('utf8')));
    expect(app.binding?.libraryId).toBe(manifest.libraryId);
    expect(app.binding?.serverBindingProofId).toBe(manifest.serverBindingProofId);
    await signIn(page, app);
    await expect(page.getByRole('link', { name: /^Open / }).first()).toBeVisible();
    const observations: object[] = [];
    const small: Array<{ itemId: string; file: BookFile; expected: typeof manifest.files[number] }> = [];
    let streamed: Record<string, unknown> | undefined;
    let streamedSha256: string | undefined;
    const streamedPath = process.env.BOOKS_STREAMED_DELIVERY_PROOF;
    if (streamedPath) {
      if (!path.isAbsolute(streamedPath) || path.relative(repoRoot, streamedPath).startsWith('..')) throw new Error('Streamed proof must stay in its execution root');
      const proof = await fs.readFile(streamedPath);
      streamed = record(JSON.parse(proof.toString('utf8')));
      streamedSha256 = createHash('sha256').update(proof).digest('hex');
      expect(streamed.verdict).toBe('pass');
      expect(streamed.runId).toBe(manifest.runId);
      expect(streamed.serverBindingProofId).toBe(manifest.serverBindingProofId);
      expect(list(streamed.files)).toHaveLength(manifest.files.length);
    }
    for (const [fileIndex, expected] of manifest.files.entries()) {
      const mapped = app.fileMap?.find(file => file.absItemId === expected.absItemId && file.absIno === expected.absIno);
      expect(mapped).toBeDefined();
      const response = await page.request.get(`${app.origin}/api/books/items/${expected.absItemId}`);
      expect(response.status()).toBe(200);
      const item = parseBookItem(await response.json());
      const original = item.files.find(file => file.fileId === mapped!.fileId);
      expect(original?.size).toBe(expected.size);
      expect(original?.role).toBe(expected.role);
      expect(item.libraryId).toBe(manifest.libraryId);
      if (expected.size > 16 * 1024 * 1024) {
        if (streamed) {
          const actual = record(list(streamed.files)[fileIndex]);
          expect(actual.itemId).toBe(expected.absItemId); expect(actual.size).toBe(expected.size);
          expect(actual.originalSha256).toBe(expected.sha256); expect(actual.resumedSha256).toBe(expected.sha256);
          expect(actual.verdict).toBe('pass');
        }
        observations.push({ itemId: item.itemId, fileId: mapped!.fileId, size: expected.size, streamedProofSha256: streamedSha256,
          verdict: streamed ? 'passed-saved-full-and-resumed-streaming-proof' : 'pending-bounded-streaming-proof' });
        continue;
      }
      small.push({ itemId: item.itemId, file: original!, expected });
    }
    const issue = await page.request.post(`${app.origin}/api/books/download-tickets`, {
      headers: { Authorization: `Bearer ${app.users[0].bearer}`, Origin: app.origin },
      data: { targets: small.map(row => ({ itemId: row.itemId, fileId: row.file.fileId, contentVersion: row.file.contentVersion })) },
    });
    expect(issue.status()).toBe(200);
    const results = list(record(await issue.json()).results);
    expect(results).toHaveLength(small.length);
    for (const [index, row] of small.entries()) {
      const result = record(results[index]);
      const ticket = record(result.ticket);
      const download = await page.request.get(`${app.origin}${String(ticket.url)}`);
      expect(download.status()).toBe(200);
      const body = await download.body();
      expect(createHash('sha256').update(body).digest('hex')).toBe(row.expected.sha256);
      observations.push({ itemId: row.itemId, fileId: row.file.fileId, size: body.length, sha256: row.expected.sha256, verdict: 'pass' });
    }
    await fs.writeFile(info.outputPath('managed-originals.json'), JSON.stringify({
      handoffSha256: createHash('sha256').update(bytes).digest('hex'), binding: app.binding,
      candidate: app.candidate, files: observations, streamedProofSha256: streamedSha256,
      verdict: streamed || small.length === manifest.files.length
        ? 'pass-for-exact-frozen-consumer-inputs-not-full-producer-acceptance'
        : 'small-originals-pass-large-originals-pending-separate-proof',
    }, null, 2));
    await capture(page, 'managed-books-catalog', info);
  });

  test('managed_dual_ebook_renders_from_the_same_frozen_manifest', async ({ page, app }, info) => {
    const { item, ebook, handoffSha256 } = await managedDual(page, app);
    const mapped = app.fileMap!.find(file => file.absItemId === ebook.absItemId && file.absIno === ebook.absIno)!;
    await page.getByLabel('Ebook original').selectOption(mapped.fileId);
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    const frame = page.frameLocator('iframe[title="EPUB reader"]');
    await expect.poll(async () => await page.locator('iframe[title="EPUB reader"]').count() ||
      await page.getByRole('button', { name: 'Resume saved position' }).count() ||
      await page.getByRole('button', { name: 'Start from beginning' }).count()).toBeGreaterThan(0);
    const restart = page.getByRole('button', { name: 'Start from beginning', exact: true });
    if (await restart.isVisible()) await restart.click();
    await expect(frame.locator('article')).toBeVisible();
    expect((await frame.locator('article').innerText()).length).toBeGreaterThan(20);
    await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    await capture(page, 'managed-dual-epub', info);
    await fs.writeFile(info.outputPath('managed-reader.json'), JSON.stringify({
      handoffSha256, candidate: app.candidate, itemId: item.itemId, fileId: mapped.fileId,
      absIno: ebook.absIno, sourceSha256: ebook.sha256, rendered: true,
    }, null, 2));
  });

  test('managed_native_original_saves_without_replacing_the_app', async ({ page, app }, info) => {
    const { item, manifest, handoffSha256 } = await managedDual(page, app);
    const expected = manifest.files.find(file => file.absItemId === item.itemId && file.role === 'audio' &&
      file.relativePath.endsWith('.mp3') && file.size <= 1024 * 1024);
    expect(expected).toBeDefined();
    const mapped = app.fileMap!.find(file => file.absItemId === expected!.absItemId && file.absIno === expected!.absIno)!;
    const original = item.files.find(file => file.fileId === mapped.fileId)!;
    const downloading = page.waitForEvent('download', { timeout: 10000 });
    await page.getByRole('button', { name: `Download original ${original.basename}`, exact: true }).click();
    const download = await downloading;
    await download.saveAs(info.outputPath('managed-native-original.bin'));
    expect(await download.failure()).toBeNull();
    const bytes = await fs.readFile(info.outputPath('managed-native-original.bin'));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(bytes.length).toBe(expected!.size);
    expect(sha256).toBe(expected!.sha256);
    await expect(page).toHaveURL(`${app.origin}/books/items/${item.itemId}`);
    await expect(page.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
    await expect(page.getByText('Started', { exact: true })).toHaveCount(1);
    await expect(page.getByText('Complete', { exact: true })).toHaveCount(0);
    expect(page.context().pages()).toHaveLength(1);
    await capture(page, 'managed-native-original-retained-app', info);
    await fs.writeFile(info.outputPath('managed-native-original.json'), JSON.stringify({
      candidate: app.candidate, handoffSha256, itemId: item.itemId, fileId: mapped.fileId,
      sourceBasename: original.basename, suggestedFilename: download.suggestedFilename(),
      bytes: bytes.length, sha256, appRetained: true, popupCount: 0,
    }, null, 2));
  });

  test('managed_dual_original_mp3_decodes_seeks_and_resumes', async ({ page, app, browserName }, info) => {
    test.skip(process.platform === 'win32' && browserName === 'webkit', 'Positive decode uses the capable Linux WebKit runtime; Windows fallback is separately verified.');
    const { item, handoffSha256 } = await managedDual(page, app);
    const audio = page.getByTestId('books-audio');
    await audio.evaluate(element => { if (element instanceof HTMLMediaElement) element.volume = 0; });
    await page.getByRole('button', { name: 'Listen', exact: true }).click();
    await expect.poll(async () => await page.getByRole('button', { name: 'Start from beginning' }).count() ||
      await page.getByRole('button', { name: 'Pause', exact: true }).count() ||
      await page.getByRole('button', { name: 'Tap to resume' }).count()).toBeGreaterThan(0);
    const restart = page.getByRole('button', { name: 'Start from beginning', exact: true });
    if (await restart.isVisible()) await restart.click();
    const waitPlaying = async () => {
      await expect(async () => {
        const tap = page.getByRole('button', { name: 'Tap to resume' });
        if (await tap.isVisible()) await tap.click();
        expect(await audio.evaluate(element => !(element as HTMLAudioElement).paused && (element as HTMLAudioElement).readyState >= 2)).toBe(true);
      }).toPass({ timeout: 10000 });
    };
    await waitPlaying();
    const before = await audio.evaluate(element => (element as HTMLAudioElement).currentTime);
    await page.waitForTimeout(250);
    expect(await audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(before + 0.1);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('combobox', { name: 'Track', exact: true }).selectOption(item.tracks[1].fileId);
    await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(1);
    expect(await audio.evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
    await page.getByRole('slider', { name: 'Book position' }).evaluate((element, value) => {
      if (!(element instanceof HTMLInputElement)) throw new Error('Seek control unavailable');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, String(value));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, item.tracks[1].startOffset + 0.3);
    await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBeCloseTo(0.3, 1);
    await page.getByRole('button', { name: 'Close audiobook' }).click();
    await expect(page.getByRole('region', { name: 'Audiobook player' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Listen', exact: true }).click();
    await page.getByRole('button', { name: 'Resume saved position' }).click();
    await waitPlaying();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Track', exact: true })).toHaveValue(item.tracks[1].fileId);
    await capture(page, 'managed-dual-audio', info);
    await fs.writeFile(info.outputPath('managed-audio.json'), JSON.stringify({
      handoffSha256, candidate: app.candidate, itemId: item.itemId, tracks: item.tracks.map(track => track.fileId),
      decodedAdvance: true, seekAndResume: true, audibleOutputClaimed: false,
    }, null, 2));
  });
});
