import fs from 'node:fs/promises';
import { test, expect, repoRoot } from './harness';
import { audioFixtures } from './audioFixture';

test('platform_audio_capability_is_observed_without_books_transport', async ({ page, app, browserName }, info) => {
  const fixture = await audioFixtures(repoRoot);
  const results: Array<{ format: string; hint: string; time: number; ready: number; mediaError: number | null; playError: string | null }> = [];
  for (const [format, sample, mime] of [
    ['mp3', fixture.mp3[0], 'audio/mpeg'],
    ['m4b', fixture.m4b, 'audio/mp4'],
  ] as const) {
    await page.goto(`${app.origin}/manifest.json`);
    await page.evaluate(({ data, mime }) => {
      const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
      const audio = document.createElement('audio');
      audio.id = 'codec-probe'; audio.volume = 0;
      audio.src = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const button = document.createElement('button'); button.textContent = 'Play codec probe';
      button.onclick = () => { void audio.play().catch(error => { button.dataset.failure = error.name; }); };
      document.body.replaceChildren(button, audio);
    }, { data: sample.bytes.toString('base64'), mime });
    await page.getByRole('button', { name: 'Play codec probe' }).click();
    await expect.poll(() => page.locator('#codec-probe').evaluate(element => {
      const audio = element as HTMLAudioElement;
      return audio.currentTime > 0.2 || Boolean(audio.error) || Boolean(document.querySelector('button')?.dataset.failure);
    }), { timeout: 8000 }).toBe(true);
    const result = await page.locator('#codec-probe').evaluate((element, mime) => {
      const audio = element as HTMLAudioElement;
      const value = { hint: audio.canPlayType(mime), time: audio.currentTime, ready: audio.readyState,
        mediaError: audio.error?.code ?? null, playError: document.querySelector('button')?.dataset.failure ?? null };
      audio.pause(); URL.revokeObjectURL(audio.src); audio.removeAttribute('src'); audio.load();
      return value;
    }, mime);
    results.push({ format, ...result });
  }
  await fs.writeFile(info.outputPath('codec-probe.json'), JSON.stringify({
    scope: 'standalone owned Blob codec diagnostic; NOT Books transport acceptance', results,
  }, null, 2));
  for (const result of results) {
    if (process.platform === 'win32' && browserName === 'webkit') {
      expect(result.mediaError).toBe(4); expect(result.playError).toBe('NotSupportedError');
      expect(result.time).toBe(0);
    } else expect(result.time).toBeGreaterThan(0.2);
  }
});
