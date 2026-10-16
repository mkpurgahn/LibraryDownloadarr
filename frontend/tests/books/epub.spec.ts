import { test, expect, signIn, capture } from './harness';
import { safeCss } from '../../src/books/reader/cssPolicy';

test.beforeEach(async ({ page }) => {
  page.on('console', message => {
    if (message.text().startsWith('EPUB section failed')) console.log(message.text());
  });
});
test('parsed_css_drops_external_imports', async () => {
  const css = await safeCss('@import "https://fixture.invalid/blocked"; p { background-image: url("about:invalid"); color: #222; }',
    async () => 'about:invalid');
  expect(css).not.toContain('@import');
  expect(css).not.toContain('https:');
});

test('reader_restores_section_fraction_privately', async ({ page, app }, info) => {
  await signIn(page, app);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  const frame = page.frameLocator('iframe[title="EPUB reader"]');
  await expect(frame.getByRole('heading', { name: 'First section' })).toBeVisible();
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  await frame.getByLabel('Font size').selectOption('24');
  await expect(frame.getByLabel('Font size')).toHaveValue('24');
  await frame.getByLabel('Contents').selectOption('1');
  await expect(frame.getByRole('heading', { name: 'Second section' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Position saved' })).toBeVisible();
  await capture(page, 'epub-second-section', info);
  await page.getByRole('link', { name: 'Back to book' }).click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Second section' })).toBeVisible();
  await signIn(page, app, 1);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'First section' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume saved position' })).toHaveCount(0);
});

test('reader_shell_has_no_remote_authority', async ({ page, app }) => {
  const external: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== app.origin) external.push(url.origin);
  });
  await signIn(page, app);
  await page.context().addCookies([{ name: 'epub-isolation-proof', value: 'owned-test-marker', url: app.origin, secure: true }]);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  const frame = page.frameLocator('iframe[title="EPUB reader"]');
  await expect(frame.getByRole('heading', { name: 'First section' })).toBeVisible();
  const contentFrame = page.frames().find(frame => frame.url() === 'about:srcdoc');
  expect(contentFrame).toBeDefined();
  const isolation = await contentFrame!.evaluate(() => {
    const can = (read: () => unknown) => { try { read(); return true; } catch { return false; } };
    return {
      parent: can(() => parent.document.title),
      cookieVisible: (() => { try { return document.cookie.includes('epub-isolation-proof'); } catch { return false; } })(),
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
      scripts: document.querySelectorAll('script').length,
      bookExecuted: 'bookScriptExecuted' in window,
      forms: document.getElementById('book')?.shadowRoot?.querySelectorAll('script,form,iframe,foreignObject,[onclick],[onload]').length,
    };
  });
  expect(isolation.parent).toBe(false);
  expect(isolation.cookieVisible).toBe(false);
  expect(isolation.csp).toContain("connect-src 'none'");
  expect(isolation.csp).toMatch(/script-src 'sha256-/);
  expect(isolation.scripts).toBe(1);
  expect(isolation.bookExecuted).toBe(false);
  expect(isolation.forms).toBe(0);
  expect(external).toEqual([]);
});

test('reader_scroll_and_explicit_second_device_takeover', async ({ page, app, browser }, info) => {
  await signIn(page, app);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  const first = page.frameLocator('iframe[title="EPUB reader"]');
  await expect(first.getByRole('heading', { name: 'First section' })).toBeVisible();
  await first.locator('#viewport').evaluate(element => { element.scrollTop = element.scrollHeight * 0.4; });
  await page.waitForTimeout(10500);
  const context = await browser.newContext({ baseURL: app.origin, ignoreHTTPSErrors: true, viewport: page.viewportSize() });
  await context.route('**/*', route => new URL(route.request().url()).origin === app.origin ? route.continue() : route.abort());
  try {
    const secondPage = await context.newPage();
    await signIn(secondPage, app, 3);
    await secondPage.getByRole('link', { name: 'A Tale in Two Formats' }).click();
    await secondPage.getByRole('link', { name: 'Read', exact: true }).click();
    await secondPage.getByRole('button', { name: 'Resume saved position', exact: true }).click();
    const second = secondPage.frameLocator('iframe[title="EPUB reader"]');
    await expect(second.getByRole('heading', { name: 'First section' })).toBeAttached();
    await expect.poll(() => second.locator('#viewport').evaluate(element => element.scrollTop / element.scrollHeight)).toBeGreaterThan(0.3);
    await first.getByLabel('Font size').selectOption('24');
    await expect(page.getByRole('button', { name: 'Continue here', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Continue here', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Position saved' })).toBeVisible();
    await capture(page, 'epub-private-takeover', info);
    await app.setUnavailable(true);
    await first.getByLabel('Font size').selectOption('20');
    await expect(page.getByRole('status').filter({ hasText: 'Position not saved yet' })).toBeVisible();
  } finally { app.setUnavailable(false); await context.close(); }
});

test('replacement_requires_explicit_restart_and_retains_old_history', async ({ page, app }) => {
  await signIn(page, app);
  await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'First section' })).toBeVisible();
  await app.replaceEpub();
  await page.reload();
  await expect(page.getByText('The original or reader policy changed.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume saved position' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start from beginning' }).click();
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Revised first section' })).toBeVisible();
});

test.describe('isolated ABS EPUB', () => {
  test.use({ liveProvider: true });
  test.skip(!process.env.BOOKS_TEST_ABS_ORIGIN, 'Requires the retained isolated ABS consumer fixture.');
  test('real_original_renders_through_the_restricted_provider', async ({ page, app }, info) => {
    await signIn(page, app);
    await page.getByRole('link', { name: 'Open LDA Dual Fixture', exact: true }).click();
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    const reader = page.frameLocator('iframe[title="EPUB reader"]');
    await expect(reader.getByRole('heading', { name: 'LDA Dual Fixture' })).toBeVisible();
    await expect(reader.getByText('Original generated test prose. Marker: consumer-dual-control.')).toBeVisible();
    await expect(reader.getByLabel('Contents')).toHaveText('Fixture chapter');
    await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    await capture(page, 'real-abs-epub', info);
  });
});

test('user_switch_cannot_save_the_previous_readers_position', async ({ page, context, app }) => {
    await signIn(page, app);
    await page.getByRole('link', { name: 'A Tale in Two Formats' }).click();
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    const reader = page.frameLocator('iframe[title="EPUB reader"]');
    await expect(reader.getByRole('heading', { name: 'First section' })).toBeVisible();
    let switched = false;
    let staleWrites = 0;
    page.on('request', request => {
      if (switched && request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/progress/ebook')) staleWrites += 1;
    });
    const second = await context.newPage();
    switched = true;
    await signIn(second, app, 1);
    await expect(page.locator('iframe')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(staleWrites).toBe(0);
});
