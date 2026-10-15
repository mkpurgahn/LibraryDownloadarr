import { test, expect, signIn, capture } from './harness';

test('windows_webkit_reports_unsupported_originals_without_transcoding', async ({ page, app, browserName }, info) => {
  test.skip(process.platform !== 'win32' || browserName !== 'webkit', 'This is the recorded Windows WebKit codec limitation, not a positive playback test.');
  await app.setAudio('normal');
  await signIn(page, app);
  await page.goto(`${app.origin}/audiobooks`);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  const transformations: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/transcode|\/burn/.test(path)) transformations.push(path);
  });
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /could not be loaded or decoded/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download original track' })).toBeEnabled();
  expect(await page.getByTestId('books-audio').evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
  expect(transformations).toEqual([]);
  await capture(page, 'windows-webkit-codec-fallback', info);
});
