import fs from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect, signIn, capture } from './harness';
import { parseBookItem, parseProgress } from '../../src/books/types';

type Format = 'cbz' | 'pdf' | 'epub';
test.use({ cbzFixtures: true });

function controls(page: Page, format: Format) {
  const owner = format === 'epub' ? page.frameLocator('iframe') : page;
  return {
    turns: owner.getByRole('button', { name: /^(Previous|Next) (page|section)$/ }),
    direct: format === 'epub' ? owner.getByLabel('Contents') : page.getByLabel('Page number'),
    view: format === 'cbz' ? page.getByRole('button', { name: 'View options' }) :
      owner.getByLabel(format === 'pdf' ? 'Zoom' : 'Font size'),
    viewport: format === 'epub' ? owner.locator('#viewport') :
      page.getByRole('region', { name: format === 'cbz' ? 'Comic page' : 'PDF pages', exact: true }),
    status: format === 'epub' ? owner.getByRole('status') : format === 'pdf' ?
      page.getByTestId('pdf-reader').getByRole('status', { includeHidden: true }) :
      page.getByRole('region', { name: 'CBZ reader' }).getByRole('status').last(),
  };
}

async function open(page: Page, format: Format) {
  const card = page.getByRole('link', { name: format === 'cbz' ? 'Open The Paper Observatory' : 'Open A Tale in Two Formats', exact: true });
  await expect(card.getByRole('img')).toHaveCount(0);
  await card.click();
  if (format === 'pdf') await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
  await page.getByRole('link', { name: 'Read', exact: true }).click();
}

async function ready(page: Page, format: Format, entry = 1) {
  await expect(controls(page, format).status).toHaveText(new RegExp(`^${format === 'epub' ? 'Section' : 'Page'} ${entry} of`));
}

async function turnVisibility(turns: Locator, paged: boolean) {
  // Soft assertions let the RED run record both fresh and switched Continuous.
  await expect.soft(turns).toHaveCount(paged ? 2 : 0, { timeout: 1000 });
}

for (const format of ['cbz', 'pdf', 'epub'] as const) {
  test(`${format} mode controls follow fresh switch fullscreen and reopen without moving the anchor`, async ({ page, app }, info) => {
    await signIn(page, app);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('books-reading-mode:')))).toEqual([]);
    await open(page, format); await ready(page, format);
    const ui = controls(page, format), mode = page.getByLabel('Reading mode');
    const observations: object[] = [];
    const observe = async (phase: string) => {
      observations.push({ phase, mode: await mode.inputValue(), visibleTurnButtons: await ui.turns.count(),
        directVisible: await ui.direct.isVisible(), viewVisible: await ui.view.isVisible() });
    };
    await expect(mode).toHaveValue('continuous');
    await turnVisibility(ui.turns, false);
    await expect(ui.direct).toBeVisible(); await expect(ui.view).toBeVisible();
    await observe('fresh-continuous');
    await capture(page, `${format}-fresh-continuous`, info);
    await mode.selectOption('paged');
    await turnVisibility(ui.turns, true);
    await mode.selectOption('continuous');
    await turnVisibility(ui.turns, false);
    await observe('paged-to-continuous');
    await capture(page, `${format}-paged-to-continuous`, info);
    if (format === 'cbz') await expect.soft(page.locator('#comic-navigation-help')).not.toContainText('First and last pages connect');

    if (format === 'epub') await ui.direct.selectOption('1');
    else {
      await ui.direct.fill('2');
      if (format === 'cbz') await page.getByRole('button', { name: 'Go to page', exact: true }).click();
      else await ui.direct.press('Enter');
    }
    await ready(page, format, 2);
    if (format === 'cbz') {
      await ui.view.click();
      await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('300');
      await ui.view.click();
    }
    await ui.viewport.evaluate((element, format) => {
      if (format === 'epub') element.scrollTop += 800;
      else {
        const current = element.querySelector<HTMLElement>('[data-page="2"]')!;
        element.scrollTop = current.offsetTop + (format === 'pdf' ? current.offsetHeight * 0.25 :
          (current.offsetHeight - element.clientHeight) * 0.4);
      }
    }, format);
    await ui.viewport.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const itemId = format === 'cbz' ? 'manga' : 'dual';
    const item = parseBookItem(await (await page.request.get(`${app.origin}/api/books/items/${itemId}`)).json());
    const file = item.files.find(file => file.extension === format)!;
    const progressUrl = `${app.origin}/api/books/items/${itemId}/progress/ebook?editionId=${file.fileId}`;
    const saveAndLeave = async () => {
      const saved = page.waitForResponse(response => response.request().method() === 'PUT' &&
        response.url().endsWith('/progress/ebook') && response.status() === 200);
      await page.getByRole('link', { name: 'Back to book', exact: true }).click(); await saved;
      const locator = parseProgress((await (await page.request.get(progressUrl)).json()).progress).locator;
      if (locator.kind === 'audio') throw new Error('Expected an ebook bookmark');
      return locator;
    };
    const resume = async () => {
      if (format === 'pdf') await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
      await page.getByRole('link', { name: 'Read', exact: true }).click();
      await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
      await ready(page, format, 2);
    };
    const before = await saveAndLeave();
    if (before.kind === 'epub') expect(before.textOffset).toBeGreaterThan(100);
    else {
      expect(before.page).toBe(2);
      expect(before.offset).toBeCloseTo(format === 'pdf' ? 0.25 : 0.4, 2);
    }
    await resume();
    for (const nextMode of ['paged', 'continuous', 'paged', 'continuous']) {
      await mode.selectOption(nextMode); await ready(page, format, 2);
      await turnVisibility(ui.turns, nextMode === 'paged');
      await expect(ui.direct).toBeVisible(); await expect(ui.view).toBeVisible();
      await observe(`seeded-${nextMode}`);
    }
    await page.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect(ui.direct).toBeHidden(); await expect(ui.view).toBeHidden();
    await turnVisibility(ui.turns, false);
    await page.getByRole('button', { name: 'Show controls', exact: true }).click();
    await expect(ui.direct).toBeVisible(); await expect(ui.view).toBeVisible();
    await turnVisibility(ui.turns, false);
    await observe('fullscreen-show-continuous');
    await page.getByRole('button', { name: 'Hide controls', exact: true }).click();
    await page.getByRole('button', { name: 'Show controls', exact: true }).click();
    await turnVisibility(ui.turns, false);
    await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
    const after = await saveAndLeave();
    expect(after).toMatchObject(before.kind === 'epub' ?
      { kind: 'epub', resourceId: before.resourceId, textOffset: before.textOffset } : { ...before });
    await resume();
    for (const nextMode of ['paged', 'continuous']) {
      await mode.selectOption(nextMode);
      await page.reload();
      await page.getByRole('button', { name: 'Resume saved position', exact: true }).click();
      await ready(page, format, 2);
      await expect(mode).toHaveValue(nextMode);
      await turnVisibility(ui.turns, nextMode === 'paged');
      await observe(`reopened-${nextMode}`);
    }
    // Restoring scroll space must recover the seeded position, not a layout clamp.
    if (format === 'cbz') {
      await ui.view.click(); await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('300'); await ui.view.click();
    }
    await expect.poll(() => ui.viewport.evaluate((element, locator) => {
      if (locator.kind !== 'epub') {
        const current = element.querySelector<HTMLElement>(`[data-page="${locator.page}"]`)!;
        const length = locator.kind === 'cbz' ? current.offsetHeight - element.clientHeight : current.offsetHeight;
        return Math.abs(element.scrollTop - current.offsetTop - length * locator.offset);
      }
      const current = document.getElementById('book')!.shadowRoot!.querySelector<HTMLElement>('[data-section="1"]')!;
      const walker = document.createTreeWalker(current.shadowRoot!.querySelector('article')!, NodeFilter.SHOW_TEXT);
      let remaining = locator.textOffset, node: Node | null;
      while ((node = walker.nextNode())) {
        if (node.parentElement?.closest('style,script')) continue;
        if (remaining <= node.textContent!.length) {
          const range = document.createRange(); range.setStart(node, remaining); range.setEnd(node, Math.min(node.textContent!.length, remaining + 1));
          return Math.abs(range.getBoundingClientRect().top - element.getBoundingClientRect().top);
        }
        remaining -= node.textContent!.length;
      }
      return 999;
    }, before)).toBeLessThanOrEqual(2);
    await fs.writeFile(info.outputPath(`${format}-controls.json`), JSON.stringify({ before, after, observations }, null, 2));
  });

  test(`${format} pending initial content follows the latest mode before and after completion`, async ({ page, app }, info) => {
    let release!: () => void, held = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(format === 'pdf' ? '**/content?*' : '**/readers/*/resources/*', async route => {
      if (route.request().method() === 'GET' && !held) { held = true; await gate; }
      await route.continue();
    });
    try {
      await signIn(page, app); await open(page, format);
      await expect.poll(() => held).toBe(true);
      const ui = controls(page, format);
      const counts: number[] = [];
      for (const mode of ['paged', 'continuous', 'paged', 'continuous']) {
        await page.getByLabel('Reading mode').selectOption(mode);
        await turnVisibility(ui.turns, mode === 'paged');
        counts.push(await ui.turns.count());
      }
      await capture(page, `${format}-pending-continuous`, info);
      release(); await ready(page, format);
      await turnVisibility(ui.turns, false);
      await expect(ui.direct).toBeVisible(); await expect(ui.view).toBeVisible();
      counts.push(await ui.turns.count());
      await fs.writeFile(info.outputPath(`${format}-pending-controls.json`), JSON.stringify({ counts }, null, 2));
    } finally { release(); }
  });
}
