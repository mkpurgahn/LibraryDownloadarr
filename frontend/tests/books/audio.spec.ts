import fs from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, signIn, capture, BooksApp } from './harness';
import { resolveAudioTime, validateChapters } from '../../src/books/audioTimeline';
import { AudioFixtureMode } from './audioFixture';

const media = (page: Page) => page.getByTestId('books-audio').evaluate(element => {
  if (!(element instanceof HTMLAudioElement)) throw new Error('Native audio element missing');
  return { time: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : 0,
    paused: element.paused, ended: element.ended, ready: element.readyState, rate: element.playbackRate,
    network: element.networkState, error: element.error?.code ?? null, hasSource: Boolean(element.src),
    currentSourceMatches: element.currentSrc === element.src, bufferedRanges: element.buffered.length };
});
async function prepare(page: Page, app: BooksApp, mode: AudioFixtureMode = 'normal') {
  test.skip(process.platform === 'win32' && test.info().project.name.startsWith('webkit-'),
    'Pinned Windows WebKit rejects MP3/AAC even in the standalone codec probe; positive audio cases run unchanged on Linux WebKit.');
  await app.setAudio(mode);
  await signIn(page, app);
  await page.getByTestId('books-audio').evaluate(element => {
    if (!(element instanceof HTMLAudioElement)) throw new Error('Native audio element missing');
    element.volume = 0;
    const events: object[] = [];
    for (const event of ['loadedmetadata', 'playing', 'pause', 'seeking', 'seeked', 'ended', 'error']) element.addEventListener(event, () => {
      events.push({ event, time: element.currentTime, ready: element.readyState, paused: element.paused, speed: element.playbackRate });
      element.dataset.proofEvents = JSON.stringify(events.slice(-200));
    });
  });
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Audiobook player' })).toBeVisible();
}
async function playing(page: Page) {
  await expect(async () => {
    const tap = page.getByRole('button', { name: 'Tap to resume', exact: true });
    if (await tap.isVisible()) await tap.click();
    const state = await media(page);
    expect(state.paused).toBe(false); expect(state.ready).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 10000 });
}
async function seek(page: Page, seconds: number) {
  await page.getByRole('slider', { name: 'Book position' }).evaluate((element, seconds) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('Audio seek control missing');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, String(seconds));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
}

test('audio_uses_abs_order_not_names', () => {
  const tracks = [{ fileId: 't2', duration: 30, startOffset: 0 }, { fileId: 't1', duration: 45, startOffset: 30 }];
  expect(resolveAudioTime(tracks, 35)).toEqual({ fileId: 't1', localSeconds: 5 });
  expect(resolveAudioTime(tracks, 29.5)).toEqual({ fileId: 't2', localSeconds: 29.5 });
  expect(resolveAudioTime(tracks, 30)).toEqual({ fileId: 't1', localSeconds: 0 });
  expect(validateChapters([{ id: 'a', title: 'Invalid overlap', start: 0, end: 40 }, { id: 'b', title: 'Overlap', start: 30, end: 60 }], 75)).toEqual([]);
  expect(() => resolveAudioTime([{ fileId: 'bad', duration: NaN, startOffset: 0 }], 0)).toThrow();
});

test('native_player_is_one_element_above_route_changes', async ({ page, app }) => {
  await app.setAudio('normal');
  await signIn(page, app);
  await page.getByTestId('books-audio').evaluate(element => { if (element instanceof HTMLMediaElement) element.volume = 0; });
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Audiobook player' })).toBeVisible();
  await expect(page.locator('audio[data-testid="books-audio"]')).toHaveCount(1);
  const menu = page.getByRole('button', { name: 'Toggle menu', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Audiobook player' })).toBeVisible();
  await expect(page.locator('audio[data-testid="books-audio"]')).toHaveCount(1);
});

test('decoded_time_seek_speed_pause_and_original_order_are_real', async ({ page, app }, info) => {
  await prepare(page, app);
  await playing(page);
  const first = await media(page);
  await page.waitForTimeout(350);
  expect((await media(page)).time).toBeGreaterThan(first.time + 0.15);
  const options = await page.getByRole('combobox', { name: 'Track', exact: true }).locator('option').allTextContents();
  expect(options[0]).toContain('99 First.mp3');
  expect(options[1]).toContain('01 Second.mp3');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const stopped = await media(page);
  await page.waitForTimeout(250);
  expect((await media(page)).time).toBeCloseTo(stopped.time, 2);
  await page.getByRole('combobox', { name: 'Track', exact: true }).selectOption({ index: 1 });
  await expect.poll(async () => (await media(page)).ready).toBeGreaterThanOrEqual(1);
  expect((await media(page)).paused).toBe(true);
  await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption('1.5');
  expect((await media(page)).rate).toBe(1.5);
  await seek(page, 1.5);
  await expect.poll(async () => (await media(page)).time).toBeCloseTo(1.5, 1);
  expect((await media(page)).paused).toBe(true);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await playing(page);
  await page.getByRole('combobox', { name: 'Chapter', exact: true }).selectOption('1');
  await playing(page);
  expect((await media(page)).rate).toBe(1.5);
  await capture(page, 'audio-original-controls', info);
  await fs.writeFile(info.outputPath('audio-events.json'), await page.getByTestId('books-audio').getAttribute('data-proof-events') ?? '[]');
});

test('play_rejection_requires_user_recovery', async ({ page, app }) => {
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    let rejected = false;
    HTMLMediaElement.prototype.play = function () {
      if (!rejected) { rejected = true; return Promise.reject(new DOMException('Owned permission fixture', 'NotAllowedError')); }
      return original.call(this);
    };
  });
  await prepare(page, app);
  await expect(page.getByRole('button', { name: 'Tap to resume' })).toBeVisible();
  expect((await media(page)).paused).toBe(true);
  await page.getByRole('button', { name: 'Tap to resume' }).click();
  await playing(page);
  await expect.poll(async () => (await media(page)).time).toBeGreaterThan(0.2);
});

test('same_source_play_abort_has_explicit_recovery', async ({ page, app }) => {
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    let rejected = false;
    HTMLMediaElement.prototype.play = function () {
      if (!rejected) { rejected = true; return Promise.reject(new DOMException('Owned interruption fixture', 'AbortError')); }
      return original.call(this);
    };
  });
  await prepare(page, app);
  await expect(page.getByRole('button', { name: 'Tap to resume' })).toBeVisible();
  await page.getByRole('button', { name: 'Tap to resume' }).click();
  await playing(page);
});

test('ended_advances_only_within_the_book_and_preserves_speed', async ({ page, app }) => {
  await prepare(page, app);
  await playing(page);
  await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption('2');
  const ids = await page.getByRole('combobox', { name: 'Track', exact: true }).locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  await expect(page.getByRole('combobox', { name: 'Track', exact: true })).toHaveValue(ids[1], { timeout: 7000 });
  await playing(page);
  expect((await media(page)).rate).toBe(2);
  await expect(page.getByRole('status').filter({ hasText: 'Finished. No other book will start.' })).toBeVisible({ timeout: 7000 });
  expect((await media(page)).paused).toBe(true);
});

test('broken_middle_track_stops_with_original_option', async ({ page, app }) => {
  await prepare(page, app, 'broken-middle');
  const requested: string[] = [];
  let transcodes = 0;
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/content')) requested.push(pathname);
    if (/transcode|\/burn/.test(pathname)) transcodes += 1;
  });
  await playing(page);
  const ids = await page.getByRole('combobox', { name: 'Track', exact: true }).locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption('2');
  await expect(page.getByRole('alert').filter({ hasText: /original track/ })).toBeVisible({ timeout: 7000 });
  await expect(page.getByRole('combobox', { name: 'Track', exact: true })).toHaveValue(ids[1]);
  await expect(page.getByRole('button', { name: 'Download original track' })).toBeEnabled();
  expect(requested.some(path => path.includes(`/files/${ids[2]}/`))).toBe(false);
  expect(transcodes).toBe(0);
  expect((await media(page)).paused).toBe(true);
});

test('resume_and_deliberate_rewind_survive_app_reload', async ({ page, app }) => {
  await prepare(page, app);
  await playing(page);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await seek(page, 5.5);
  await expect.poll(async () => Number(await page.getByRole('slider', { name: 'Book position' }).inputValue())).toBeCloseTo(5.5, 1);
  await page.getByRole('button', { name: 'Close audiobook' }).click();
  await expect(page.getByRole('region', { name: 'Audiobook player' })).toHaveCount(0);
  await page.reload();
  await page.getByTestId('books-audio').evaluate(element => { if (element instanceof HTMLMediaElement) element.volume = 0; });
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await page.getByRole('button', { name: 'Resume saved position' }).click();
  await playing(page);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  expect(Number(await page.getByRole('slider', { name: 'Book position' }).inputValue())).toBeGreaterThanOrEqual(5.4);
  await seek(page, 0.5);
  await expect.poll(async () => (await media(page)).time).toBeCloseTo(0.5, 1);
  await page.getByRole('button', { name: 'Close audiobook' }).click();
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await page.getByRole('button', { name: 'Resume saved position' }).click();
  await playing(page);
  expect(Number(await page.getByRole('slider', { name: 'Book position' }).inputValue())).toBeLessThan(2);
});

test('explicit_close_waits_for_the_latest_private_position', async ({ page, app }) => {
  await prepare(page, app);
  await playing(page);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  let release: () => void = () => {};
  let started: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const saving = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/books/items/*/progress/audio', async route => {
    const body = route.request().method() === 'PUT' ? route.request().postDataJSON() : undefined;
    if (body?.op === 'save' && body.locator?.globalSeconds > 5) { started(); await held; }
    await route.continue();
  });
  try {
    await seek(page, 5.5);
    await saving;
    await page.getByRole('button', { name: 'Close audiobook' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saving listening position' })).toBeVisible();
    release();
    await expect(page.getByRole('region', { name: 'Audiobook player' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Listen', exact: true }).click();
    await page.getByRole('button', { name: 'Resume saved position' }).click();
    await playing(page);
    expect(Number(await page.getByRole('slider', { name: 'Book position' }).inputValue())).toBeGreaterThan(5.4);
  } finally { release(); }
});

test('audio_writer_conflicts_require_explicit_takeover', async ({ page, app, browser }, info) => {
  await prepare(page, app, 'm4b');
  await playing(page);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await seek(page, 6);
  await expect.poll(async () => (await media(page)).time).toBeCloseTo(6, 1);
  const context = await browser.newContext({ baseURL: app.origin, viewport: page.viewportSize(), ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === app.origin ? route.continue() : route.abort());
  try {
    const other = await context.newPage();
    await other.bringToFront();
    const responses: object[] = [];
    other.on('response', response => {
      if (new URL(response.url()).pathname.endsWith('/content')) responses.push({
        status: response.status(), range: response.request().headers().range ?? null,
      });
    });
    await signIn(other, app, 3);
    await fs.writeFile(info.outputPath('second-device-visibility.json'), JSON.stringify(await other.evaluate(() => ({
      visibility: document.visibilityState, focused: document.hasFocus(),
    })), null, 2));
    await other.getByTestId('books-audio').evaluate(element => { if (element instanceof HTMLMediaElement) element.volume = 0; });
    await other.getByRole('link', { name: 'A Tale in Two Formats' }).click();
    await other.getByRole('button', { name: 'Listen', exact: true }).click();
    await other.getByRole('button', { name: 'Resume saved position' }).click();
    try { await playing(other); } catch (error) {
      const source = await other.getByTestId('books-audio').evaluate(element => (element as HTMLAudioElement).src);
      if (new URL(source).origin !== app.origin) throw new Error('Unexpected diagnostic media origin');
      const fetched = await other.request.get(source, { timeout: 5000 });
      const body = await fetched.body();
      await fs.writeFile(info.outputPath('second-device-diagnostic.json'), JSON.stringify({
        media: await media(other), responses, player: await other.getByRole('region', { name: 'Audiobook player' }).innerText(),
        directFetch: { status: fetched.status(), bytes: body.length, contentType: fetched.headers()['content-type'] },
      }, null, 2));
      await other.evaluate(({ bytes, mime }) => {
        const original = document.querySelector('audio');
        original?.pause();
        const audio = document.createElement('audio');
        audio.id = 'second-device-probe'; audio.volume = 0;
        audio.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(bytes), character => character.charCodeAt(0))], { type: mime }));
        const button = document.createElement('button'); button.textContent = 'Play second device probe';
        button.onclick = () => { void audio.play().catch(error => { button.dataset.failure = error.name; }); };
        document.body.append(button, audio);
      }, { bytes: body.toString('base64'), mime: fetched.headers()['content-type'] });
      await other.getByRole('button', { name: 'Play second device probe', exact: true }).click();
      await other.waitForTimeout(1500);
      await fs.writeFile(info.outputPath('second-device-blob-probe.json'), JSON.stringify(await other.locator('#second-device-probe').evaluate(element => {
        const audio = element as HTMLAudioElement;
        const result = { time: audio.currentTime, ready: audio.readyState, error: audio.error?.code ?? null,
          playError: document.querySelector<HTMLButtonElement>('button[data-failure]')?.dataset.failure ?? null };
        audio.pause(); URL.revokeObjectURL(audio.src); audio.remove();
        return result;
      }), null, 2));
      throw error;
    }
    await other.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.bringToFront();
    await seek(page, 1);
    await expect(page.getByRole('button', { name: 'Continue here' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue here' }).click();
    await playing(page);
    expect((await media(page)).time).toBeLessThan(3);
  } finally { await context.close(); }
});

test('user_change_clears_audio_and_does_not_reuse_private_progress', async ({ page, app, context }) => {
  await prepare(page, app, 'm4b');
  await playing(page);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await seek(page, 7);
  const other = await context.newPage();
  await signIn(other, app, 1);
  await expect(page.getByRole('region', { name: 'Audiobook player' })).toHaveCount(0);
  expect(await page.getByTestId('books-audio').getAttribute('src')).toBeNull();
  await other.getByTestId('books-audio').evaluate(element => { if (element instanceof HTMLMediaElement) element.volume = 0; });
  await other.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await other.getByRole('button', { name: 'Listen', exact: true }).click();
  await playing(other);
  await expect(other.getByRole('button', { name: 'Resume saved position' })).toHaveCount(0);
  expect((await media(other)).time).toBeLessThan(3);
});

test('audio_resume_survives_an_actual_backend_restart', async ({ page, app }) => {
  await prepare(page, app, 'm4b');
  await playing(page);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await seek(page, 5);
  await expect.poll(async () => (await media(page)).time).toBeCloseTo(5, 1);
  await page.getByRole('button', { name: 'Close audiobook' }).click();
  await expect(page.getByRole('region', { name: 'Audiobook player' })).toHaveCount(0);
  const previous = app.instanceId;
  await app.restart();
  expect(app.instanceId).not.toBe(previous);
  await page.reload();
  await page.getByTestId('books-audio').evaluate(element => { if (element instanceof HTMLMediaElement) element.volume = 0; });
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await page.getByRole('button', { name: 'Resume saved position' }).click();
  await playing(page);
  expect((await media(page)).time).toBeGreaterThanOrEqual(4.9);
});

test('m4b_decodes_and_saves_during_elapsed_playback', async ({ page, app }, info) => {
  const saves: number[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/progress/audio') && request.method() === 'PUT') {
      const body = request.postDataJSON();
      if (body?.op === 'save') saves.push(body.locator?.globalSeconds);
    }
  });
  await prepare(page, app, 'm4b');
  await playing(page);
  expect((await media(page)).duration).toBeCloseTo(12, 0);
  await expect.poll(async () => (await media(page)).time, { timeout: 13000 }).toBeGreaterThan(10.1);
  expect(saves.some(time => time > 0.1)).toBe(true);
  expect((await media(page)).time - Math.max(...saves)).toBeLessThanOrEqual(10.5);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await capture(page, 'audio-m4b-decoded', info);
  await fs.writeFile(info.outputPath('m4b-events.json'), await page.getByTestId('books-audio').getAttribute('data-proof-events') ?? '[]');
});

test.describe('isolated ABS original audio', () => {
  test.use({ liveProvider: true });
  test.skip(!process.env.BOOKS_TEST_ABS_ORIGIN, 'Requires the original retained consumer fixture.');
  test('real_m4b_decodes_seeks_and_pauses_without_provider_sessions', async ({ page, app, browserName }, info) => {
    test.skip(process.platform === 'win32' && browserName === 'webkit', 'Positive original decode is verified on Linux WebKit; Windows fallback is separate.');
    await signIn(page, app);
    await page.getByTestId('books-audio').evaluate(element => { if (element instanceof HTMLMediaElement) element.volume = 0; });
    await page.getByRole('link', { name: 'Open LDA AAC Fixture', exact: true }).click();
    await page.getByRole('button', { name: 'Listen', exact: true }).click();
    await playing(page);
    const start = await media(page);
    await page.waitForTimeout(350);
    expect((await media(page)).time).toBeGreaterThan(start.time + 0.15);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await seek(page, 6);
    await expect.poll(async () => (await media(page)).time).toBeCloseTo(6, 1);
    expect((await media(page)).paused).toBe(true);
    await capture(page, 'real-abs-m4b-paused', info);
    await fs.writeFile(info.outputPath('real-m4b.json'), JSON.stringify({ ...await media(page), source: 'retained-independent-ABS-fixture', audibleOutputClaimed: false }, null, 2));
  });
});
