import { test, expect, capture } from './harness';

test.use({ cbzFixtures: true, reverseProxy: true });
test.skip(process.env.BOOKS_TEST_LEGACY_BACKEND !== 'true', 'Run against the saved9f backend with the new client bundle.');

test('new CBZ client falls back to the actual legacy complete server without hanging on partial state', async ({ page, app }, info) => {
  await page.goto(`${app.origin}/manifest.json`);
  await page.evaluate(token => localStorage.setItem('token', token), app.users[0].bearer);
  await page.goto(`${app.origin}/books/items/manga`);
  const unsupported = page.waitForResponse(response => response.url().endsWith('/reader-progressive'));
  const complete = page.waitForResponse(response => response.url().endsWith('/reader') && response.request().method() === 'POST');
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  expect((await unsupported).status()).toBe(404);
  const legacy = await complete;
  expect(legacy.status()).toBe(200);
  expect((await legacy.json()).state).toBe('ready');
  await expect(page.getByRole('img', { name: 'Comic page 1 of 3', exact: true })).toBeVisible();
  await page.getByLabel('Page number').fill('2');
  await page.getByRole('button', { name: 'Go to page', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Comic page 2 of 3', exact: true })).toBeVisible();
  await expect(page.getByText('Position saved', { exact: true })).toBeVisible();
  await capture(page, 'new-client-legacy-server', info);
});
