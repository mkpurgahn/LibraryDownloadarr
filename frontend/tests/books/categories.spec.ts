import fs from 'node:fs/promises';
import { test, expect, signIn, capture } from './harness';

test('categories_keep_mixed_titles_and_download_only_ebooks_in_distinct_destinations', async ({ page, app }, info) => {
  await signIn(page, app);
  await expect(page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open One Hundred and One Tracks', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Download-only Archive', exact: true })).toHaveCount(0);
  await capture(page, 'books-category', info);
  await page.goto(`${app.origin}/ebooks`);
  await expect(page.getByRole('heading', { name: 'Ebooks', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open One Hundred and One Tracks', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open Download-only Archive', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/ebooks/items/dual`);
  await expect(page.getByRole('link', { name: 'Back to Ebooks', exact: true })).toHaveAttribute('href', '/ebooks');
  const toggle = page.getByRole('button', { name: 'Toggle menu', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Ebooks', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Books', exact: true })).not.toHaveAttribute('aria-current', 'page');
  if (await toggle.isVisible()) await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Listen', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Audiobook player' }).getByRole('link')).toHaveAttribute('href', '/ebooks/items/dual');
  await page.getByRole('button', { name: 'Close audiobook', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Read', exact: true })).toHaveAttribute('href', /\/ebooks\/items\/dual\/read\//);
  await capture(page, 'ebooks-mixed-detail', info);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Back to book', exact: true })).toHaveAttribute('href', '/ebooks/items/dual');
  await page.getByRole('link', { name: 'Back to book', exact: true }).click();
  await page.getByRole('link', { name: 'Back to Ebooks', exact: true }).click();
  await page.getByRole('link', { name: 'Open Download-only Archive', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Read', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Download original/ })).toBeEnabled();
  await page.goto(`${app.origin}/books/items/unsupported`);
  await expect(page.getByRole('heading', { name: 'Download-only Archive', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Books', exact: true })).toHaveAttribute('href', '/books');
});

test('category_search_keeps_filters_counts_and_truthful_retry', async ({ page, app }, info) => {
  await signIn(page, app);
  await page.getByRole('combobox', { name: 'Available sources' }).selectOption('single');
  await page.getByRole('textbox', { name: 'Search books', exact: true }).fill('Two Formats');
  await page.getByRole('textbox', { name: 'Search books', exact: true }).press('Enter');
  await expect(page.getByText('No books found', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Available sources' }).selectOption('multi');
  await expect(page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true })).toBeVisible();
  await expect(page.getByText('1 books - Page 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  await capture(page, 'books-filtered-search', info);
  app.setUnavailable(true);
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('No books found', { exact: true })).toHaveCount(0);
  app.setUnavailable(false);
  await page.getByRole('button', { name: 'Retry Books', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open A Tale in Two Formats', exact: true })).toBeVisible();
  await fs.writeFile(info.outputPath('category-contract.json'), JSON.stringify({
    generatedInputs: true, mixedInBoth: true, ebookOnlyExcludedFromBooks: true,
    categoryAppliedDuringSearch: true, failureIsNotEmpty: true, appearance: 'not accepted',
  }, null, 2));
});

test('category_switch_cancels_stale_results_and_restriction_is_not_new_authority', async ({ page, app }) => {
  await signIn(page, app);
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let received!: () => void;
  const requested = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/books/libraries/*/items?*', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('category') !== 'books' || !url.searchParams.has('q')) return route.continue();
    const response = await route.fetch();
    received();
    await delayed;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('textbox', { name: 'Search books', exact: true }).fill('Tracks');
    await page.getByRole('textbox', { name: 'Search books', exact: true }).press('Enter');
    await requested;
    const toggle = page.getByRole('button', { name: 'Toggle menu', exact: true });
    if (await toggle.isVisible()) await toggle.click();
    await page.getByRole('navigation').getByRole('button', { name: 'Ebooks', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Open Download-only Archive', exact: true })).toBeVisible();
    release();
    await expect(page.getByRole('link', { name: 'Open One Hundred and One Tracks', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Ebooks', exact: true })).toBeVisible();
    const base = `${app.origin}/api/books/libraries/163ac435-50a9-4f56-96d0-276edf9303c1/items`;
    expect((await page.request.get(`${base}?category=ebooks&filter=multi`)).status()).toBe(400);
    expect((await page.request.get(`${base}?category=ebooks&q=${'x'.repeat(201)}`)).status()).toBe(400);
    expect((await page.request.get(`${app.origin}/api/books/libraries/unselected/items?category=ebooks`)).status()).toBe(404);
    expect((await page.request.get(`${app.origin}/api/books/items/unsupported`)).status()).toBe(200);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test.describe('large generated categories', () => {
  test.use({ categoryFixtures: true });
  test('saved_build_search_and_pagination_do_not_filter_only_one_provider_batch', async ({ page, app }, info) => {
    // Keep this rapid multi-page query proof separate from the unchanged cover/read rate budget.
    await page.route('**/api/books/items/*/cover', route => route.fulfill({ status: 404, body: '' }));
    await signIn(page, app);
    await expect(page.getByText('3312 books - Page 1', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Search books', exact: true }).fill('Generated 16');
    await page.getByRole('textbox', { name: 'Search books', exact: true }).press('Enter');
    await expect(page.getByText('110 books - Page 1', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(50);
    await expect(page.getByRole('link', { name: 'Open Generated 1600 mixed', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Generated 1600 ebook', exact: true })).toHaveCount(0);
    await capture(page, 'large-books-search', info);
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(page.getByText('110 books - Page 2', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Generated 1625 mixed', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(page.getByText('110 books - Page 3', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(10);
    await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
    await capture(page, 'large-books-last-page', info);
    await page.goto(`${app.origin}/ebooks`);
    await expect(page.getByText('3312 ebooks - Page 1', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Search ebooks', exact: true }).fill('Generated 16');
    await page.getByRole('textbox', { name: 'Search ebooks', exact: true }).press('Enter');
    await expect(page.getByText('110 ebooks - Page 1', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Generated 1600 ebook', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Generated 1600 single', exact: true })).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Sort', exact: true }).selectOption('author');
    await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(50);
    await capture(page, 'large-ebooks-search', info);
    await fs.writeFile(info.outputPath('large-category-contract.json'), JSON.stringify({
      fixtureItems: 4968, books: 3312, ebooks: 3312, nativeMatches: 165, matchesPerCategory: 110,
      pages: [50, 50, 10], categoryFilteringPrecedesPaging: true,
      generatedInputs: true, liveCatalogTouched: false, covers: 'synthetic 404; catalog/search/API/auth are real',
    }, null, 2));
  });
});
