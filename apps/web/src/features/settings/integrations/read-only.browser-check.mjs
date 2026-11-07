// SPDX-License-Identifier: AGPL-3.0-only
// The read-only email and payments sections of a multi-gym install in the built app, at 360 px and 1280 px.
// Build the web app first (`pnpm --filter @plaingym/web build`), then run `node apps/web/src/features/settings/integrations/read-only.browser-check.mjs`.
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium, expect } = await import(pathToFileURL(resolve('e2e/node_modules/@playwright/test/index.mjs')).href);
const { default: AxeBuilder } = await import(pathToFileURL(resolve('e2e/node_modules/@axe-core/playwright/dist/index.mjs')).href);
const output = resolve('coverage/settings/integrations-read-only'), dist = resolve('apps/web/dist'); await mkdir(output, { recursive: true });
const title = 'Email, payments and backups';
const gym = { id: '00000000-0000-7000-8000-000000000001', name: 'A long gym name that must fit on a phone', timezone: 'UTC', currency: 'USD', enabledModules: [] };
const session = { userId: '00000000-0000-7000-8000-000000000002', displayName: 'Owner', roles: ['owner'], member: false };
const settings = { id: gym.id, name: gym.name, slug: 'gym', timezone: 'UTC', currency: 'USD', address: {}, branding: {}, websiteEnabled: false,
  existingSiteUrl: null, bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false, billingEnabled: false,
  memberEmailsEnabled: false, retryDays: [3, 7], dropInChargeTypeId: null, revision: 3, createdAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-01T12:00:00Z' };
const signIn = { password: false, magicLink: true };
const installEmail = { source: 'install', host: null, port: null, security: null, from: null, signIn, signInAfterSave: signIn, signInAfterRemove: null, removeBlocked: false };
const noStripe = { configured: false, mode: null, webhookRegistered: false, accountLocked: false, testData: null, importedCustomersOnly: false };
const base = { email: installEmail, payments: noStripe, backups: null, sandbox: false, integrationsEditable: false, revision: 3 };
const stored = { ...base,
  email: { ...installEmail, source: 'gym', host: 'a-very-long-smtp-host-name-that-has-to-wrap.mail.gym-with-a-long-domain.example', port: 587, security: 'starttls',
    from: 'front-desk-with-a-long-address@gym-with-a-long-domain.example', signInAfterRemove: signIn },
  payments: { ...noStripe, configured: true, mode: 'live', webhookRegistered: true, accountLocked: true } };
let integrations = base;
const api = (path) => {
  if (path === '/api/demo') return { data: { mode: 'disabled' } };
  if (path === '/api/auth/bootstrap') return { data: { gym, session, login: signIn } };
  if (path === '/api/settings') return { data: settings };
  if (path === '/api/settings/integrations') return { data: integrations };
  return undefined;
};
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    const body = api(path); res.setHeader('Content-Type', 'application/json');
    if (body === undefined) res.statusCode = 404;
    res.end(JSON.stringify(body ?? { error: { code: 'not_found', message: 'Not found' } })); return;
  }
  if (path.startsWith('/assets/')) { res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(resolve(dist, 'assets', path.slice('/assets/'.length)))); return; }
  if (/\.(js|webmanifest|png|svg|ico)$/.test(path)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', 'text/html'); res.end(await readFile(resolve(dist, 'index.html')));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing server address');
const profile = await mkdtemp(resolve(output, 'profile-'));
if (!profile.startsWith(output + sep)) throw new Error('Unexpected profile directory');
const origin = `http://127.0.0.1:${address.port}`, browser = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true });
const errors = [];
try {
  const page = await browser.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const region = page.getByRole('region', { name: title });
    const check = async (name) => {
      await page.goto(origin + '/admin/settings');
      await expect(region.getByText(/Whoever runs this install manages email and payments/)).toBeVisible();
      await expect(region.getByRole('heading', { name: 'Email', exact: true })).toBeVisible();
      await expect(region.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
      await expect(region.getByRole('textbox')).toHaveCount(0);
      await expect(region.getByRole('form')).toHaveCount(0);
      await expect(region.getByRole('button')).toHaveCount(1);
      expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), name).toBe(true);
      expect(await region.evaluate((element) => [...element.querySelectorAll('button,input,select,a')].filter((control) => control.getClientRects().length
        && control.getBoundingClientRect().height < 44).map((control) => control.outerHTML.slice(0, 120))), name).toEqual([]);
      expect((await new AxeBuilder({ page }).include(`section[aria-label="${title}"]`).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations, name).toEqual([]);
      await region.screenshot({ path: resolve(output, `${name}-${width}.png`) });
    };
    integrations = base; await check('install-email-no-stripe');
    integrations = stored; await check('stored-email-and-stripe');
  }
  // Other sections read endpoints this check doesn't serve; their 404s are expected.
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Read-only integrations browser checks passed; screenshots in ' + output);
} finally {
  await browser.close(); server.close(); await rm(profile, { recursive: true, force: true });
}
