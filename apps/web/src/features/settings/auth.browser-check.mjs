// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in page with Google and the Google settings section in the built app, at 360 px and 1280 px.
// Build the web app first (`pnpm --filter @plaingym/web build`), then run `node apps/web/src/features/settings/auth.browser-check.mjs`.
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium, expect } = await import(pathToFileURL(resolve('e2e/node_modules/@playwright/test/index.mjs')).href);
const { default: AxeBuilder } = await import(pathToFileURL(resolve('e2e/node_modules/@axe-core/playwright/dist/index.mjs')).href);
const output = resolve('coverage/settings/google-browser'), dist = resolve('apps/web/dist'); await mkdir(output, { recursive: true });
const gym = { id: '00000000-0000-7000-8000-000000000001', name: 'A long gym name that must fit on a phone', timezone: 'UTC', currency: 'USD', enabledModules: [] };
let session = null, login = { password: false, magicLink: true, google: true };
const api = (path) => {
  if (path === '/api/demo') return { data: { mode: 'disabled' } };
  if (path === '/api/auth/bootstrap') return { data: { gym, session, login } };
  return undefined;
};
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    const body = api(path); res.setHeader('Content-Type', 'application/json');
    if (body === undefined) res.statusCode = 404;
    res.end(JSON.stringify(body ?? { error: { code: 'not_found', message: 'Not found' } })); return;
  }
  if (path.startsWith('/assets/')) { res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(resolve(dist, 'assets', path.split('/').at(-1)))); return; }
  if (/\.(js|webmanifest|png|svg|ico)$/.test(path)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', 'text/html'); res.end(await readFile(resolve(dist, 'index.html')));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
const profile = await mkdtemp(resolve(output, 'profile-'));
if (!profile.startsWith(output + sep)) throw new Error('Unexpected profile directory');
const origin = `http://127.0.0.1:${address.port}`, browser = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true });
const errors = [];
try {
  const page = await browser.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const check = async (name) => {
      expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), name).toBe(true);
      expect(await page.evaluate(() => [...globalThis.document.querySelectorAll('button,input,select,a')].filter((element) => !element.classList.contains('sr-only') && element.getClientRects().length
        && element.getBoundingClientRect().height < 44 && element.closest('main')).map((element) => element.outerHTML.slice(0, 120))), name).toEqual([]);
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations, name).toEqual([]);
      await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true });
    };
    session = null; login = { password: false, magicLink: true, google: true };
    await page.goto(origin + '/login'); await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeVisible(); await check('login-google-and-email');
    await page.goto(origin + '/login?error=account_not_linked'); await expect(page.getByText(/must match your login's verified email/)).toBeVisible(); await check('login-not-linked');
    login = { password: false, magicLink: false, google: true };
    await page.goto(origin + '/login'); await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
    await expect(page.getByText(/Sign-in is currently unavailable/)).toHaveCount(0); await check('login-google-only');
    session = { userId: '00000000-0000-7000-8000-000000000002', displayName: 'Owner', roles: ['owner'], member: false }; login = { password: false, magicLink: true, google: true };
    await page.goto(origin + '/admin/settings'); await expect(page.getByRole('heading', { name: 'Google sign-in' })).toBeVisible();
    await expect(page.getByText(origin + '/api/auth/callback/google')).toBeVisible();
    await page.getByRole('region', { name: 'Google sign-in' }).screenshot({ path: resolve(output, `settings-google-${width}.png`) });
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), 'settings').toBe(true);
    login = { password: false, magicLink: true, google: false };
    await page.goto(origin + '/admin/settings'); await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Google sign-in' })).toHaveCount(0);
  }
  // Other sections read endpoints this check doesn't serve; their 404s are expected.
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Google sign-in browser checks passed; screenshots in ' + output);
} finally {
  await browser.close(); server.close(); await rm(profile, { recursive: true, force: true });
}
