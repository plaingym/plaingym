// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { test, expect, demoClient, type Client, type Sandbox } from '../support.js';
import { accessibleThemes as accessibleLayout } from '../responsive.js';

// The public website in a seeded sandbox: every page under the enforced policy (the automatic CSP guard fails the test
// on any violation), at phone and desktop widths, and the switch that takes it away again.
const pages = ['/', '/programs', '/schedule', '/plans', '/coaches', '/contact'];
const phone = { width: 360, height: 740 }, desktop = { width: 1280, height: 800 };
interface Website { revision: number; tagline: string | null; about: string | null; phone: string | null; email: string | null;
  accentColor: string | null; primaryColor: string | null; logo: boolean; photos: { id: string; alt: string }[] }

async function setWebsite(owner: Client, on: boolean) {
  const settings = (await owner.json<{ data: { revision: number; websiteEnabled: boolean } }>('/api/settings')).data;
  if (settings.websiteEnabled !== on) await owner.json('/api/settings', 'PATCH', { revision: settings.revision, websiteEnabled: on });
}
async function customize(owner: Client) {
  // Demo sandboxes refuse uploads, so the photo and logo are covered by the module's own tests (website.test.ts).
  const current = (await owner.json<{ data: Website }>('/api/website')).data;
  await owner.json('/api/website', 'PUT', { revision: current.revision, photos: current.photos, primaryColor: current.primaryColor, tagline: 'Classes for every level, seven days a week',
    about: 'A friendly academy for beginners and competitors alike.\nYour first class is on us.', phone: '+1 555 0100',
    email: 'hello@example.test', accentColor: '#1f2937' });
}
async function open(page: Page, sandbox: Sandbox, path: string) {
  const response = await page.goto(sandbox.origin + path);
  expect(response?.status(), path).toBe(200);
  expect(response?.headers()['content-security-policy'], path).toMatch(/script-src 'nonce-[^']+'/);
  await expect(page.locator('h1').first(), path).toBeVisible();
}

test('the website pages load under their own policy and fit a 360 px phone and a desktop', async ({ page, sandboxes }, info) => {
  test.setTimeout(180_000);
  const sandbox = sandboxes[1]!, owner = await demoClient(sandbox, 'owner');
  await setWebsite(owner, true);
  try {
    await customize(owner);
    for (const size of [phone, desktop]) {
      await page.setViewportSize(size);
      for (const path of pages) {
        await open(page, sandbox, path);
        await accessibleLayout(page, info, `website${path === '/' ? '-home' : path.replace('/', '-')}-${size.width}`);
      }
    }
    // Structured data for search engines, in a block that runs nothing.
    await open(page, sandbox, '/');
    const data = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent() ?? '{}') as Record<string, unknown>;
    expect(data).toMatchObject({ '@context': 'https://schema.org', '@type': 'LocalBusiness', url: sandbox.origin + '/' });
    await expect(page.getByText('Classes for every level, seven days a week')).toBeVisible();
    // On a phone the navigation is a menu that needs no script.
    await page.setViewportSize(phone);
    await page.getByText('Menu', { exact: true }).click();
    await page.getByRole('navigation', { name: 'Website' }).getByRole('link', { name: 'Schedule' }).last().click();
    await page.waitForURL(sandbox.origin + '/schedule');
    await expect(page.getByRole('heading', { level: 1, name: 'Schedule' })).toBeVisible();
    // The calls to action reach the core public pages, which keep their own policy.
    await page.getByRole('link', { name: 'Try a class' }).first().click();
    await page.waitForURL(sandbox.origin + '/trial');
    for (const path of ['/sitemap.xml', '/robots.txt']) expect((await owner.request(path)).status, path).toBe(200);
  } finally { await setWebsite(owner, false); }
});

test('with the website off, / goes to the portal, its pages are gone and the core pages stay', async ({ page, sandboxes }) => {
  const sandbox = sandboxes[1]!, owner = await demoClient(sandbox, 'owner');
  await setWebsite(owner, false);
  const root = await owner.request('/');
  expect(root.status).toBe(302); expect(root.location).toBe('/portal');
  await page.goto(sandbox.origin + '/');
  // The portal sends a visitor without a session on to sign in.
  await page.waitForURL((url) => /^\/(?:portal|login)(?:\/|$)/.test(url.pathname));
  for (const path of pages.slice(1)) expect((await owner.request(path)).status, path).toBe(404);
  expect((await owner.request('/api/website')).status).toBe(404);
  const trial = await page.goto(sandbox.origin + '/trial');
  expect(trial?.status()).toBe(200);
});
