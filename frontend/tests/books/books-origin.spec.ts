import fs from 'node:fs/promises';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect, signIn, capture, originalDownload } from './harness';

test.use({ reverseProxy: true });

async function buttonStyle(button: Locator) {
  return button.evaluate(element => {
    const css = getComputedStyle(element);
    const luminance = (color: string) => {
      const rgb = (color.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number).map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const foreground = luminance(css.color);
    const background = luminance(css.backgroundColor);
    return { backgroundImage: css.backgroundImage, backgroundColor: css.backgroundColor, color: css.color,
      contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
      shadow: css.boxShadow, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height };
  });
}

async function record(page: Page, info: TestInfo) {
  await capture(page, 'books-proxy', info);
  await fs.writeFile(info.outputPath('books-proxy-input.json'), JSON.stringify({
    source: 'actual saved frontend and backend; isolated generated catalog and valid application identity',
    topology: 'HTTPS browser -> TLS-terminating fixture proxy -> HTTP Express; trustProxy=1; inner proxy overwrites X-Forwarded-Proto=http, preserves Host',
    input: 'existing synthetic Books provider: A Tale in Two Formats, Download-only Archive, One Hundred and One Tracks',
    productionCredentialsOrSessionsUsed: false,
    button: await buttonStyle(page.getByRole('button', { name: 'Search', exact: true }).last()),
    viewport: page.viewportSize(),
  }, null, 2));
}

test('proxy_books_capture', async ({ page, app }, info) => {
  await signIn(page, app);
  await expect(page.getByRole('link', { name: 'Open A Tale in Two Formats' })
    .or(page.getByText('Same-origin request required', { exact: true }))).toBeVisible();
  await record(page, info);
});

test('proxy_books_bootstrap_search_retry_and_detail_are_protected_and_work', async ({ page, app }, info) => {
  const events: Array<{ method: string; route: string; status: number }> = [];
  page.on('response', response => {
    const route = new URL(response.url()).pathname;
    if (route.startsWith('/api/books/')) events.push({ method: response.request().method(), route, status: response.status() });
  });
  const exchanged = page.waitForResponse(response => new URL(response.url()).pathname === '/api/books/media-session');
  await signIn(page, app);
  const book = page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true });
  await expect(book).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const cookie = (await page.context().cookies()).find(cookie => cookie.name === '__Secure-lda_books');
  expect(cookie).toMatchObject({ secure: true, httpOnly: true, path: '/api/books' });
  const setCookie = await (await exchanged).headerValue('set-cookie');
  expect(setCookie).toMatch(/;\s*SameSite=Strict/i);
  expect(setCookie).toMatch(/;\s*Secure/i);
  expect(setCookie).toMatch(/;\s*HttpOnly/i);
  await page.getByRole('textbox', { name: 'Search books' }).fill('Two Formats');
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(1);
  await expect(book).toBeVisible();
  app.setUnavailable(true);
  await page.getByRole('textbox', { name: 'Search books' }).fill('unavailable');
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  await expect(page.getByRole('alert')).toBeVisible();
  app.setUnavailable(false);
  await page.getByRole('textbox', { name: 'Search books' }).fill('Two Formats');
  await page.getByRole('button', { name: 'Search', exact: true }).last().click();
  await page.route('**/api/books/libraries', route => route.fulfill({ status: 503, json: { code: 'BOOKS_UNAVAILABLE', error: 'Fixture temporary catalog outage' } }));
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry Books', exact: true })).toBeVisible();
  await page.unroute('**/api/books/libraries');
  await page.getByRole('button', { name: 'Retry Books', exact: true }).click();
  await expect(book).toBeVisible();
  await book.click();
  await expect(page.getByRole('heading', { name: 'A Tale in Two Formats', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Read', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.frameLocator('iframe[title="EPUB reader"]').getByRole('heading', { name: 'First section', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to book', exact: true }).click();
  const download = await originalDownload(page, () => page.getByRole('button', { name: /Download original/ }).first().click(), info);
  await download.saveAs(info.outputPath('proxy-original.epub'));
  expect(await download.failure()).toBeNull();
  await expect(page.getByRole('heading', { name: 'A Tale in Two Formats', exact: true })).toBeVisible();
  await expect(page.locator('iframe[title="Books original download"]')).toBeHidden();
  await fs.writeFile(info.outputPath('proxy-navigation.json'), JSON.stringify({
    events, realProtectedCards: true, secureHttpOnlyStrictCookieHeader: true,
    browserReportedSameSite: cookie?.sameSite,
  }, null, 2));
  expect(events.some(event => event.method === 'POST' && event.route === '/api/books/media-session' && event.status === 200)).toBe(true);
});

test('proxy_origin_rejects_foreign_missing_and_forged_origins_without_authority', async ({ page, app }) => {
  const request = page.request;
  const auth = { Authorization: `Bearer ${app.users[0].bearer}` };
  const endpoint = `${app.origin}/api/books/media-session`;
  for (const headers of [
    { ...auth },
    { ...auth, Origin: 'null' },
    { ...auth, Origin: 'https://foreign.invalid' },
    { ...auth, Origin: app.origin, 'Sec-Fetch-Site': 'cross-site' },
    { ...auth, Origin: 'https://foreign.invalid', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'foreign.invalid' },
  ]) {
    const response = await request.post(endpoint, { headers });
    expect(response.status()).toBe(403);
    expect((await response.json()).code).toBe('SAME_ORIGIN_REQUIRED');
    expect(response.headers()['set-cookie']).toBeUndefined();
  }
  const unauthenticated: Record<string, string>[] = [
    { Origin: app.origin }, { Origin: app.origin, Authorization: 'Bearer invalid-fixture-session' },
  ];
  for (const headers of unauthenticated) {
    const response = await request.post(endpoint, { headers });
    expect(response.status()).toBe(401);
    expect(response.headers()['set-cookie']).toBeUndefined();
  }
  const allowed = await request.post(endpoint, { headers: { ...auth, Origin: app.origin, 'Sec-Fetch-Site': 'same-origin' } });
  expect(allowed.status()).toBe(200);
  const cookie = allowed.headers()['set-cookie'].split(';')[0];
  expect((await request.post(endpoint, { headers: { Cookie: cookie, Origin: app.origin } })).status()).toBe(401);
  expect((await request.get(`${app.origin}/api/books/libraries`, { headers: auth })).status()).toBe(200);
  const conflict = await request.get(`${app.origin}/api/books/libraries`, {
    headers: { Authorization: `Bearer ${app.users[1].bearer}`, Cookie: cookie },
  });
  expect(conflict.status()).toBe(403);
});

test('shared_primary_button_is_solid_with_readable_states_and_unchanged_geometry', async ({ page, app }, info) => {
  await signIn(page, app);
  await expect(page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true })).toBeVisible();
  const search = page.getByRole('button', { name: 'Search', exact: true }).last();
  const normal = await buttonStyle(search);
  expect(normal.backgroundImage).toBe('none');
  expect(normal.contrast).toBeGreaterThanOrEqual(4.5);
  await search.hover();
  await expect.poll(async () => (await buttonStyle(search)).backgroundColor).not.toBe(normal.backgroundColor);
  const hover = await buttonStyle(search);
  expect(hover.contrast).toBeGreaterThanOrEqual(4.5);
  await search.focus();
  expect((await buttonStyle(search)).shadow).not.toBe('none');
  await search.evaluate(button => { (button as HTMLButtonElement).disabled = true; });
  const disabled = await buttonStyle(search);
  expect(disabled.backgroundImage).toBe('none');
  expect(disabled.contrast).toBeGreaterThanOrEqual(4.5);
  expect(disabled.height).toBe(normal.height);
  expect(disabled.width).toBe(normal.width);
  await fs.writeFile(info.outputPath('primary-states.json'), JSON.stringify({ normal, hover, disabled }, null, 2));
});
