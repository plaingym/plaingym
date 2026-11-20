// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, clientAddress } from '../support.js';

const showcase = 'https://showcase.demo.localhost';
const destinations = [
  { name: 'Gym admin', role: 'owner', path: '/admin', heading: 'Dashboard', session: { roles: ['owner'], member: false } },
  { name: 'Member portal', role: 'student', path: '/portal', heading: 'Welcome to your member portal', session: { roles: [], member: true } },
] as const;

for (const destination of destinations) for (const width of [360, 1280]) {
  // The page and its browser context are recreated by Playwright for each test.
  test(`signed-out demo visitor opens ${destination.name} at ${width}px`, async ({ page }, info) => {
    await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': clientAddress() });
    await page.setViewportSize({ width, height: 900 });
    const visitedPaths: string[] = [];
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) visitedPaths.push(new URL(frame.url()).pathname);
    });
    const readSession = () => page.evaluate(async () => {
      const response = await fetch('/api/auth/bootstrap');
      if (!response.ok) throw new Error(`Bootstrap returned ${response.status}`);
      return (await response.json()).data.session;
    });

    await page.goto(showcase + '/demo');
    await expect(page.getByRole('heading', { name: 'Your demo gym', exact: true })).toBeVisible();
    expect(await readSession()).toBeNull();
    await page.getByRole('button', { name: 'Demo menu', exact: true }).click();
    const menu = page.getByRole('dialog', { name: 'Demo menu', exact: true });
    const control = menu.getByRole('button', { name: destination.name, exact: true });
    await expect(control).toBeEnabled();
    const bounds = await control.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await control.scrollIntoViewIfNeeded();
    await info.attach('demo-menu', { body: await page.screenshot(), contentType: 'image/png' });

    const login = page.waitForResponse(response => new URL(response.url()).pathname === '/api/demo/login');
    await control.click();
    const response = await login;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ role: destination.role });
    await expect(page).toHaveURL(showcase + destination.path);
    await expect(page.getByRole('heading', { name: destination.heading, exact: true })).toBeVisible();
    expect(await readSession()).toMatchObject(destination.session);
    expect(visitedPaths).not.toContain('/login');
  });
}
