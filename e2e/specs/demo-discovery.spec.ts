// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';

for (const { role, width } of [{ role: 'owner', width: 360 }, { role: 'coach', width: 1280 }] as const) {
  test(`ordinary ${role} at ${width}px shares discovery across navigation, focus, reconnect and staff reload`, async ({ page, context, install }) => {
    // The browser's implicit icon request is unrelated to capability discovery.
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
    await page.setViewportSize({ width, height: 800 });
    await install.clients[role].browser(context);
    const probes: { path: string; status: number }[] = [];
    const errors: string[] = [];
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (path === '/api/demo' || path === '/api/demo/status') probes.push({ path, status: response.status() });
    });
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(gymOrigin + '/admin');
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    const navigate = async (path: string) => {
      if (width === 360) await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.locator(`#admin-navigation a[href="${path}"]`).click();
      await expect(page).toHaveURL(gymOrigin + path);
    };
    // Tags are the last request in the calendar's initial load. Let it finish
    // before taking the browser offline to exercise demo discovery on reconnect.
    const scheduleLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/schedule/tags' && response.status() === 200);
    await navigate('/admin/schedule');
    await expect(page.getByRole('heading', { name: 'Schedule', exact: true })).toBeVisible();
    await (await scheduleLoaded).finished();
    if (role === 'owner') {
      await navigate('/admin/staff');
      await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === '/api/staff/profiles' && response.status() === 200),
        page.waitForResponse((response) => new URL(response.url()).pathname === '/api/staff/roles' && response.status() === 200),
        page.getByRole('button', { name: 'Reload staff', exact: true }).click(),
      ]);
    }
    await context.setOffline(true);
    await context.setOffline(false);
    await page.evaluate(async () => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(probes).toEqual([{ path: '/api/demo', status: 200 }]);
    expect(errors).toEqual([]);
    await expect(page.getByRole('button', { name: 'Try the demo', exact: true })).toHaveCount(0);
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(size.scroll).toBeLessThanOrEqual(size.client);
  });
}

test('ordinary discovery keeps server failures visible, and JSON uploads get a structured 400', async ({ page, context, install }) => {
  await install.clients.owner.browser(context);
  await page.route('**/api/demo', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await page.goto(gymOrigin + '/admin');
  await expect(page.getByRole('alert').filter({ hasText: 'The demo is unavailable.' })).toBeVisible();
  await page.unroute('**/api/demo');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The demo is unavailable.' })).toHaveCount(0);
  const response = await install.clients.owner.request<{ error: { code: string; message: string }; requestId: string }>('/api/imports/uploads', 'POST', { file: 'people.csv' });
  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({ error: { code: 'invalid_request', message: expect.any(String) }, requestId: expect.any(String) });
});
