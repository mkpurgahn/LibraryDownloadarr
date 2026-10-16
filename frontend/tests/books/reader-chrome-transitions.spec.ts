import fs from 'node:fs/promises';
import type { Locator } from '@playwright/test';
import { test, expect, signIn, capture, revealReaderControls, hideReaderControls } from './harness';

test.use({ cbzFixtures: true, hasTouch: true });

async function transitions(elements: Locator) {
  return elements.evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    const properties = style.transitionProperty.split(',').map(value => value.trim());
    const durations = style.transitionDuration.split(',').map(value => parseFloat(value));
    const delays = style.transitionDelay.split(',').map(value => parseFloat(value));
    return {
      tag: element.tagName, id: element.id, label: element.getAttribute('aria-label') ??
        (element.matches('button,a,select') ? element.textContent : null),
      properties, durations, delays, visibility: style.visibility,
      canAnimateVisibility: properties.some((property, index) => ['all', 'visibility'].includes(property) &&
        (durations[index % durations.length] > 0 || delays[index % delays.length] > 0)),
      visibilityAnimations: element.getAnimations().filter(animation => animation.effect instanceof KeyframeEffect &&
        animation.effect.getKeyframes().some(frame => 'visibility' in frame)).length,
    };
  }));
}

for (const format of ['cbz', 'pdf', 'epub'] as const) {
  test(`${format} reader chrome visibility never depends on transitions`, async ({ page, app }, info) => {
    await signIn(page, app);
    const card = page.getByRole('link', { name: format === 'cbz' ? 'Open The Paper Observatory' : 'Open A Tale in Two Formats', exact: true });
    await expect(card.getByRole('img')).toHaveCount(0);
    await card.click();
    if (format === 'pdf') await page.getByLabel('Ebook original').selectOption({ label: 'A Tale in Two Formats 2.pdf' });
    await expect(page.getByRole('link', { name: 'Read', exact: true })).toBeVisible();
    const originalFeedback = await transitions(page.getByRole('link', { name: 'Read', exact: true }));
    expect(originalFeedback[0].properties).toContain('all');
    expect(originalFeedback[0].durations.some(value => value > 0)).toBe(true);
    await page.getByRole('link', { name: 'Read', exact: true }).click();
    const owner = format === 'epub' ? page.frameLocator('iframe') : page;
    if (format === 'epub') await expect(owner.getByRole('heading', { name: 'First section' })).toBeVisible();
    else await expect(page.getByRole('img', { name: format === 'cbz' ? /Comic page 1/ : 'PDF page 1', exact: format === 'pdf' })).toBeVisible();
    const viewport = format === 'epub' ? owner.locator('#viewport') :
      page.getByRole('region', { name: format === 'cbz' ? 'Comic page' : 'PDF pages', exact: true });
    await page.getByLabel('Reading mode').selectOption('paged');
    await expect(owner.getByRole('button', { name: 'Next page', exact: true })).toBeVisible();
    if (format === 'cbz') await page.getByRole('button', { name: 'View options' }).click();
    const observations: object[] = [];
    const inspect = async (state: string, hidden = false) => {
      const elements = page.locator('[data-reader-chrome], [data-reader-chrome] *');
      const values = [...await transitions(elements), ...(format === 'epub'
        ? await transitions(owner.locator('[data-reader-chrome], [data-reader-chrome] *')) : [])];
      expect(values.filter(value => value.tag === 'BUTTON').length).toBeGreaterThanOrEqual(3);
      expect(values.filter(value => value.canAnimateVisibility || value.visibilityAnimations)).toEqual([]);
      if (hidden) expect(values.filter(value => value.visibility !== 'hidden')).toEqual([]);
      observations.push({ state, values });
    };
    await inspect('normal-paged');
    const feedback = (await transitions(page.getByRole('button', { name: 'Full screen', exact: true })))[0];
    expect(feedback.properties).toEqual(expect.arrayContaining(['background-color', 'box-shadow']));
    expect(feedback.durations.some(value => value > 0)).toBe(true);
    await page.getByRole('button', { name: 'Full screen', exact: true }).click();
    await capture(page, `${format}-initial-hidden-with-hint`, info);
    await expect(page.getByRole('button', { name: 'Exit full screen', exact: true })).toBeHidden({ timeout: 1000 });
    await expect(page.getByRole('status').filter({ hasText: 'Press Esc to exit fullscreen.' })).toBeVisible();
    await inspect('initial-hidden', true);
    await revealReaderControls(page);
    await inspect('corner-revealed');
    await hideReaderControls(page, viewport);
    await inspect('leave-hidden', true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toBeFocused();
    await inspect('exited');
    await page.getByRole('link', { name: 'Back to book', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Read', exact: true })).toBeVisible();
    expect(await transitions(page.getByRole('link', { name: 'Read', exact: true }))).toEqual(originalFeedback);
    await fs.writeFile(info.outputPath(`${format}-chrome-transitions.json`), JSON.stringify({ originalFeedback, feedback, observations }, null, 2));
  });
}
