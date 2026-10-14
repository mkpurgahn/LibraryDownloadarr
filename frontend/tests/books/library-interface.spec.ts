import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, capture, signIn } from './harness';
import type { Library, MediaItem } from '../../src/types';

const libraries: Library[] = [
  { key: 'fixture-movies', title: 'Movies', type: 'movie' },
  { key: 'fixture-tv', title: 'TV Shows', type: 'show' },
];
const media: MediaItem[] = [
  { ratingKey: 'fixture-1', key: '/library/metadata/fixture-1', title: 'A Map of the Quiet Coast', type: 'movie', year: 2025 },
  { ratingKey: 'fixture-2', key: '/library/metadata/fixture-2', title: 'The Observatory Beyond the Last Mountain', grandparentTitle: 'The Long Way Home', parentIndex: 2, index: 4, type: 'episode' },
  { ratingKey: 'fixture-3', key: '/library/metadata/fixture-3', title: 'Notes from a Small Planet', type: 'movie', year: 2024 },
  { ratingKey: 'fixture-4', key: '/library/metadata/fixture-4', title: 'An Unexpected Visitor', grandparentTitle: 'Letters from the Northern Islands', parentIndex: 1, index: 12, type: 'episode' },
  { ratingKey: 'fixture-5', key: '/library/metadata/fixture-5', title: 'The Shape of Tomorrow', type: 'movie', year: 2026 },
  { ratingKey: 'fixture-6', key: '/library/metadata/fixture-6', title: 'Missing Artwork Example', type: 'movie', year: 2025 },
  { ratingKey: 'fixture-7', key: '/library/metadata/fixture-7', title: 'Across the Evening Sky', type: 'movie', year: 2024 },
  { ratingKey: 'fixture-8', key: '/library/metadata/fixture-8', title: 'A Place to Begin Again', type: 'movie', year: 2025 },
].map((item, index) => ({ ...item, ...(index === 5 ? {} : { thumb: `/fixture-art/${index}` }) }));

async function plexFixture(page: Page) {
  const requests: string[] = [];
  const errors: string[] = [];
  const expectedErrors: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) requests.push(`${request.method()} ${url.pathname}${url.search}`);
  });
  page.on('response', response => {
    if (response.status() < 400) return;
    const pathname = new URL(response.url()).pathname;
    const target = response.status() === 404 && /^\/api\/books\/items\/(dual|unsupported|collection)\/cover$/.test(pathname)
      ? expectedErrors : errors;
    target.push(`${response.status()} ${pathname}`);
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => errors.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
  await page.route('**/api/libraries', route => route.fulfill({ json: { libraries } }));
  await page.route('**/api/libraries/*/content*', route => route.fulfill({ json: { content: media } }));
  await page.route('**/api/media/recently-added*', route => route.fulfill({ json: { media } }));
  await page.route('**/api/media/download-stats', route => route.fulfill({ json: { stats: { count: 15, total_size: 50830971372 } } }));
  await page.route('**/api/media/search*', route => route.fulfill({ json: { results: media.slice(0, 1) } }));
  await page.route('**/api/media/fixture-*', route => route.fulfill({ json: { metadata: media[0] } }));
  await page.route('**/api/media/thumb/*', route => {
    const index = Number(new URL(route.request().url()).pathname.split('-').at(-1)) - 1;
    const colors = ['#34494d', '#55455f', '#61523d', '#3d4e67', '#594850', '#3b5052', '#454865', '#5a4e42'];
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600"><rect width="400" height="600" fill="${colors[index]}"/><rect x="40" y="60" width="320" height="400" fill="none" stroke="#ffffff" stroke-opacity=".25"/><circle cx="200" cy="260" r="${70 + index * 7}" fill="none" stroke="#ffffff" stroke-opacity=".35" stroke-width="2"/><text x="40" y="510" fill="#ffffff" font-family="sans-serif" font-size="20">FIXTURE ARTWORK ${index + 1}</text><text x="40" y="544" fill="#ffffff" font-family="sans-serif" font-size="14">Synthetic layout test, not a real title</text></svg>`,
    });
  });
  return { requests, errors, expectedErrors };
}

async function home(page: Page, app: Parameters<typeof signIn>[1], owner = true) {
  await page.goto(`${app.origin}/manifest.json`);
  await page.evaluate(token => localStorage.setItem('token', token), app.users[owner ? 2 : 0].bearer);
  await page.goto(`${app.origin}/`);
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await expect(page.locator('main').getByText(media[0].title, { exact: true }).last()).toBeVisible();
}

async function openNavigation(page: Page) {
  const toggle = page.getByRole('button', { name: 'Toggle menu', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  return page.getByRole('navigation', { name: 'Main navigation' });
}

test('matched_library_home_capture', async ({ page, app }, info) => {
  const observations = await plexFixture(page);
  await home(page, app);
  await page.locator('main img').evaluateAll(images => images.forEach(image => {
    if (image instanceof HTMLImageElement) image.loading = 'eager';
  }));
  await expect.poll(() => page.locator('main img').evaluateAll(images => images.every(image =>
    image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
  await capture(page, 'library-home', info);
  const toggle = page.getByRole('button', { name: 'Toggle menu', exact: true });
  if (await toggle.isVisible()) {
    await toggle.click();
    await capture(page, 'library-navigation-open', info);
  }
  await fs.writeFile(info.outputPath('library-input.json'), JSON.stringify({
    fixture: 'library-interface-v1', identity: 'isolated synthetic owner; real app session via existing Books harness',
    libraries, media, artwork: 'authored geometric SVG test cards, no third-party content',
    stats: { count: 15, total_size: 50830971372 },
    inputSha256: createHash('sha256').update(JSON.stringify({ libraries, media })).digest('hex'),
    ...observations, appearance: 'pending review, not accepted',
  }, null, 2));
  expect(observations.errors).toEqual([]);
});

test('books_belongs_to_libraries_and_home_destinations_are_real', async ({ page, app }, info) => {
  const observations = await plexFixture(page);
  await home(page, app);
  const destinations = page.locator('main').getByRole('region', { name: 'Libraries', exact: true });
  await expect(destinations.getByRole('link', { name: 'Movies', exact: true })).toHaveAttribute('href', '/library/fixture-movies');
  await expect(destinations.getByRole('link', { name: 'TV Shows', exact: true })).toHaveAttribute('href', '/library/fixture-tv');
  await expect(destinations.getByRole('link', { name: 'Books', exact: true })).toHaveAttribute('href', '/books');
  expect(observations.requests.filter(value => value === 'GET /api/libraries')).toHaveLength(1);
  expect(observations.requests.filter(value => value === 'GET /api/books/libraries')).toHaveLength(1);
  const navigation = await openNavigation(page);
  const group = navigation.getByRole('region', { name: 'Libraries', exact: true });
  await expect(group.getByRole('button', { name: 'Books', exact: true })).toHaveCount(1);
  await expect(navigation.getByRole('button', { name: 'Books', exact: true })).toHaveCount(1);
  await group.getByRole('button', { name: 'Books', exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/books`);
  await page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A Tale in Two Formats', exact: true })).toBeVisible();
  const bookNav = await openNavigation(page);
  await expect(bookNav.getByRole('button', { name: 'Books', exact: true })).toHaveAttribute('aria-current', 'page');
  await bookNav.getByRole('button', { name: 'Home', exact: true }).click();
  await destinations.getByRole('link', { name: 'Movies', exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/library/fixture-movies`);
  await expect(page.locator('main').getByRole('button', { name: /A Map of the Quiet Coast/ })).toBeVisible();
  await fs.writeFile(info.outputPath('navigation.json'), JSON.stringify(observations, null, 2));
  expect(observations.errors).toEqual([]);
});

test('books_configuration_change_discards_pending_navigation_without_refetching_plex', async ({ page, app }) => {
  const observations = await plexFixture(page);
  let release!: () => void;
  let received!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { received = resolve; });
  let requests = 0;
  await page.route('**/api/books/libraries', async route => {
    requests += 1;
    if (requests === 1) {
      received();
      await delayed;
      await route.fulfill({ json: [{ providerInstanceId: 'fixture-provider', libraryId: 'fixture-library', name: 'Books' }] });
    } else await route.fulfill({ json: [] });
  });
  try {
    await home(page, app);
    await requested;
    await page.evaluate(() => window.dispatchEvent(new Event('librarydownloadarr:books-changed')));
    await expect.poll(() => requests).toBe(2);
    release();
    const navigation = await openNavigation(page);
    await expect(navigation.getByRole('button', { name: 'Books', exact: true })).toHaveCount(0);
    await expect(navigation.getByRole('button', { name: 'Movies', exact: true })).toBeVisible();
    expect(observations.requests.filter(value => value === 'GET /api/libraries')).toHaveLength(1);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('layout_survives_small_intermediate_wide_and_enlarged_text', async ({ page, app }, info) => {
  await plexFixture(page);
  await home(page, app);
  const measurements = [];
  for (const width of [320, 768, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    measurements.push({ width, bodyWidth: await page.locator('body').evaluate(element => element.scrollWidth) });
  }
  await page.setViewportSize({ width: 768, height: 900 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await fs.writeFile(info.outputPath('enlarged-text-overflow.json'), JSON.stringify(await page.evaluate(() =>
    [...document.querySelectorAll('body *')].filter(element => element.getBoundingClientRect().right > window.innerWidth + 1)
      .map(element => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right }))), null, 2));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('main').getByRole('link', { name: 'Books', exact: true })).toBeVisible();
  await fs.writeFile(info.outputPath('responsive-layout.json'), JSON.stringify(measurements, null, 2));
});

test('books_remains_navigable_during_plex_loading_and_failure', async ({ page, app }) => {
  await plexFixture(page);
  await signIn(page, app);
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/libraries', async route => {
    await delayed;
    await route.fulfill({ status: 503, json: { error: 'Synthetic Plex outage' } });
  });
  try {
    await page.goto(`${app.origin}/`);
    const destinations = page.locator('main').getByRole('region', { name: 'Libraries', exact: true });
    await expect(destinations.getByRole('link', { name: 'Books', exact: true })).toBeVisible();
    const navigation = await openNavigation(page);
    await expect(navigation.getByRole('region', { name: 'Libraries' }).getByRole('button', { name: 'Books', exact: true })).toBeVisible();
    release();
    await expect(navigation.getByText('Plex libraries unavailable.', { exact: true })).toBeVisible();
    await navigation.getByRole('button', { name: 'Books', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Books', exact: true })).toBeVisible();
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

for (const state of ['empty', 'disabled', 'denied', 'outage'] as const) {
  test(`plex_destinations_survive_books_${state}`, async ({ page, app }) => {
    await plexFixture(page);
    await signIn(page, app);
    await page.route('**/api/books/media-session', route => state === 'disabled'
      ? route.fulfill({ status: 503, json: { code: 'BOOKS_DISABLED', error: 'Books disabled for fixture' } })
      : route.continue());
    await page.route('**/api/books/libraries', route => state === 'empty'
      ? route.fulfill({ json: [] })
      : route.fulfill({ status: 503, json: { code: state === 'denied' ? 'PLEX_ACCESS_REQUIRED' : 'BOOKS_UNAVAILABLE', error: 'Fixture state' } }));
    await page.goto(`${app.origin}/`);
    const destinations = page.locator('main').getByRole('region', { name: 'Libraries', exact: true });
    await expect(destinations.getByRole('link', { name: 'Movies', exact: true })).toBeVisible();
    await expect(destinations.getByRole('link', { name: 'TV Shows', exact: true })).toBeVisible();
    const navigation = await openNavigation(page);
    await expect(navigation.getByRole('button', { name: 'Books', exact: true })).toHaveCount(state === 'outage' ? 1 : 0);
    await navigation.getByRole('button', { name: 'TV Shows', exact: true }).click();
    await expect(page).toHaveURL(`${app.origin}/library/fixture-tv`);
  });
}

test('home_management_is_compact_role_gated_and_preserves_facts', async ({ page, app }) => {
  const observations = await plexFixture(page);
  await home(page, app);
  const management = page.locator('main').getByRole('region', { name: 'Management' });
  await expect(management.getByRole('link', { name: /Downloads/ })).toHaveAttribute('href', '/admin/download-history');
  await expect(management).toContainText('15');
  await expect(management).toContainText('47.34 GB');
  await expect(management.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('href', '/settings');
  const box = await management.boundingBox();
  expect(box!.height).toBeLessThan(145);
  await home(page, app, false);
  await expect(management).toHaveCount(0);
  const navigation = await openNavigation(page);
  await expect(navigation.getByRole('button', { name: /Download History|Logs|Settings/ })).toHaveCount(0);
  expect(observations.requests.filter(value => value === 'GET /api/media/download-stats')).toHaveLength(1);
});

test('navigation_focus_mobile_close_and_header_search_remain_usable', async ({ page, app }, info) => {
  await plexFixture(page);
  await home(page, app);
  const toggle = page.getByRole('button', { name: 'Toggle menu', exact: true });
  if (await toggle.isVisible()) {
    await toggle.focus();
    const navigation = await openNavigation(page);
    await expect(navigation.getByRole('button', { name: 'Home', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(navigation.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(toggle).toBeFocused();
    await expect(navigation).toBeHidden();
    await toggle.click();
    await page.getByRole('button', { name: 'Close navigation' }).click({ position: { x: 350, y: 400 } });
    await expect(toggle).toBeFocused();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
  }
  const search = page.getByPlaceholder('Search media...').filter({ visible: true });
  await search.fill('Quiet Coast');
  await search.press('Enter');
  await expect(page).toHaveURL(`${app.origin}/search?q=Quiet%20Coast`);
  await expect(page.locator('main').getByRole('button', { name: /A Map of the Quiet Coast/ })).toBeVisible();
  await capture(page, 'search-navigation', info);
});

test('media_titles_artwork_and_keyboard_targets_fit_the_viewport', async ({ page, app }, info) => {
  await plexFixture(page);
  await home(page, app);
  const card = page.locator('main').getByRole('button', { name: /The Long Way Home.*The Observatory Beyond the Last Mountain/ });
  await expect(card).toBeVisible();
  const title = card.getByRole('heading', { name: 'The Long Way Home', exact: true });
  const subtitle = card.getByText('S02E04 - The Observatory Beyond the Last Mountain', { exact: true });
  const measure = await subtitle.evaluate(element => {
    const style = getComputedStyle(element);
    return { height: element.clientHeight, lineHeight: parseFloat(style.lineHeight), fontSize: parseFloat(style.fontSize), clamp: style.webkitLineClamp };
  });
  expect(measure.clamp).not.toBe('1');
  expect(measure.height).toBeGreaterThan(measure.lineHeight);
  expect(measure.fontSize).toBeGreaterThanOrEqual(14);
  await expect(title).toBeVisible();
  const artwork = await card.locator('img').boundingBox();
  expect(artwork!.width / artwork!.height).toBeCloseTo(2 / 3, 1);
  await card.focus();
  await expect(card).toBeFocused();
  expect(await card.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await fs.writeFile(info.outputPath('title-layout.json'), JSON.stringify({ measure, artwork, viewport: page.viewportSize() }, null, 2));
  await card.press('Enter');
  await expect(page).toHaveURL(`${app.origin}/media/fixture-2`);
});
