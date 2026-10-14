import fs from 'node:fs/promises';
import { test, expect, capture } from './harness';

for (const closure of ['before-result', 'after-result'] as const) {
  test(`authorized_plex_login_retains_session_when_popup_closes_${closure}`, async ({ page, app }, info) => {
    const current = await page.request.get(`${app.origin}/api/auth/me`, {
      headers: { Authorization: `Bearer ${app.users[0].bearer}` },
    });
    expect(current.status()).toBe(200);
    const { user } = await current.json();
    let received!: () => void;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { received = resolve; });
    const authorized = new Promise<void>(resolve => { release = resolve; });
    let checks = 0;
    await page.route('**/api/auth/plex/pin', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ id: 123, code: 'synthetic-local-pin', url: `${app.origin}/manifest.json` }),
    }));
    await page.route('**/api/auth/plex/authenticate', async route => {
      expect(route.request().postDataJSON()).toEqual({ pinId: 123 });
      checks += 1;
      received();
      await authorized;
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ user, token: app.users[0].bearer }),
      });
    });
    try {
      await page.goto(`${app.origin}/login`);
      await expect(page.getByRole('button', { name: 'Sign in with Plex', exact: true })).toBeVisible();
      const opened = page.waitForEvent('popup');
      await page.getByRole('button', { name: 'Sign in with Plex', exact: true }).click();
      const popup = await opened;
      await expect(page.getByRole('button', { name: 'Waiting for Plex...', exact: true })).toBeDisabled();
      await pending;
      const completion = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/auth/plex/authenticate' && response.status() === 200);
      if (closure === 'before-result') await popup.close();
      release();
      await completion;
      await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem('token')))).toBe(true);
      if (closure === 'after-result') await popup.close();
      await expect(page).toHaveURL(`${app.origin}/`);
      await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign in with Plex', exact: true })).toHaveCount(0);
      await page.goto(`${app.origin}/books`);
      await expect(page.getByRole('heading', { name: 'Books', exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Books', exact: true })).toBeVisible();
      expect(checks).toBe(1);
      await capture(page, `authorized-login-${closure}`, info);
      await fs.writeFile(info.outputPath('login-transition.json'), JSON.stringify({
        simulatedBoundary: 'authorized Plex exchange response using an independently valid isolated application session',
        closure, authorizedPollResponses: checks, tokenPersisted: true,
        homeWithoutReload: true, booksAccessible: true, reloadRetainsSession: true,
        realPlexCredentialsUsed: false, productionSessionCreated: false,
      }, null, 2));
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

test('denied_plex_exchange_does_not_enter_protected_routes', async ({ page, app }) => {
  await page.route('**/api/auth/plex/pin', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ id: 124, code: 'synthetic-denied-pin', url: `${app.origin}/manifest.json` }),
  }));
  await page.route('**/api/auth/plex/authenticate', route => route.fulfill({
    status: 403, contentType: 'application/json',
    body: JSON.stringify({ error: 'Access denied. You do not have access to this Plex server.' }),
  }));
  await page.goto(`${app.origin}/login`);
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in with Plex', exact: true }).click();
  const popup = await opened;
  await expect(page.getByText('Access denied. You do not have access to this Plex server.', { exact: true })).toBeVisible();
  await popup.close();
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
  await expect(page).toHaveURL(`${app.origin}/login`);
  await expect(page.getByRole('button', { name: 'Sign in with Plex', exact: true })).toBeEnabled();
});

test('bootstrap_success_uses_the_same_session_transition_and_survives_reload', async ({ page, app }) => {
  const response = await page.request.get(`${app.origin}/api/auth/me`, {
    headers: { Authorization: `Bearer ${app.users[2].bearer}` },
  });
  expect(response.status()).toBe(200);
  const { user } = await response.json();
  let setupRequired = true;
  await page.route('**/api/auth/setup/required', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ setupRequired }),
  }));
  await page.route('**/api/auth/setup', async route => {
    expect(route.request().postDataJSON()).toEqual({
      username: 'fixture-bootstrap', password: 'fixture-bootstrap-password',
    });
    setupRequired = false;
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ user, token: app.users[2].bearer }),
    });
  });
  await page.goto(`${app.origin}/setup`);
  await page.getByPlaceholder('Choose a username').fill('fixture-bootstrap');
  await page.getByPlaceholder('Choose a secure password').fill('fixture-bootstrap-password');
  await page.getByRole('button', { name: 'Continue to Plex Configuration', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${app.origin}/`);
  expect(await page.evaluate(() => Boolean(localStorage.getItem('token')))).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
});
