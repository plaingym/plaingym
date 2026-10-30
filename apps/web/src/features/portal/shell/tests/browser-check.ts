// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const { chromium, expect } = await import(pathToFileURL(resolve('e2e/node_modules/@playwright/test/index.mjs')).href);
const { default: AxeBuilder } = await import(pathToFileURL(resolve('e2e/node_modules/@axe-core/playwright/dist/index.mjs')).href);
const require = createRequire(resolve('apps/server/package.json'));
const { build } = await import(pathToFileURL(require.resolve('esbuild')).href);
const { OpenAPIHono } = await import(pathToFileURL(require.resolve('@hono/zod-openapi')).href);
const { createPortalPwaRoutes } = await import(pathToFileURL(resolve('apps/server/src/areas/portal/auth.pwa.ts')).href);
const output = resolve('coverage/portal/browser'), dist = resolve('apps/web/dist'); await mkdir(output, { recursive: true });
const gym = '00000000-0000-7000-8000-000000000001', household = '00000000-0000-7000-8000-000000000002', member = '00000000-0000-7000-8000-000000000003', userId = '00000000-0000-7000-8000-000000000004';
const bootstrap = { gym: { id: gym, name: 'A long gym name that must fit on a phone', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId, roles: [], member: true }, login: { password: true, magicLink: false } };
const person = { id: member, householdId: household, firstName: 'Alex', lastName: 'Example', email: 'alex@example.test', phone: null, photoKey: null, dateOfBirth: '1990-01-01', status: 'active', emergencyContacts: [], emailOptOut: false, emailDeliverable: true, anonymizedAt: null, revision: 1, createdAt: '2026-10-28T12:00:00Z' };
const login = { id: gym, householdId: household, userId, scope: 'member', memberId: member, createdAt: person.createdAt, email: person.email };
const second = '00000000-0000-7000-8000-000000000005';
const choices = [{ householdId: household, name: 'A household with a long name that wraps on a phone', role: 'payer' }, { householdId: second, name: 'Second household', role: 'member' }];
let revoked = false, awaiting = false, current: string | null = null;
const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {QueryClient,QueryClientProvider} from '@tanstack/react-query'; import {ShellServicesContext} from './src/app/context.tsx'; import {PortalAccessTab} from './src/features/portal/access/tab.tsx'; const services={loadBootstrap:async()=>(${JSON.stringify({ ...bootstrap, session: { userId, roles: ['front_desk'], member: false } })})}; createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ShellServicesContext.Provider value={services}><main className="mx-auto max-w-4xl p-4"><h1 className="text-2xl font-semibold">Alex Example</h1><PortalAccessTab memberId="${member}"/></main></ShellServicesContext.Provider></QueryClientProvider>);`, resolveDir: resolve('apps/web'), sourcefile: 'portal-access-browser.tsx', loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic' });
await writeFile(resolve(output, 'access.js'), bundle.outputFiles[0]!.text);
const cssName = (await readdir(resolve(dist, 'assets'))).find(name => name.endsWith('.css'))!;
const pwa = new OpenAPIHono(); for (const entry of createPortalPwaRoutes()) entry.mount(pwa, () => async (_ctx: unknown, next: () => Promise<void>) => { await next(); });
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (/^\/portal\/(sw\.js|manifest\.webmanifest|icon-\d+\.png)$/.test(path)) {
    const response = await pwa.request(path); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
  }
  if (path.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (path === '/api/demo') { res.end(JSON.stringify({ data: { mode: 'disabled' } })); return; }
    if (path === '/api/auth/bootstrap') { res.end(JSON.stringify({ data: bootstrap })); return; }
    if (path === '/api/portal/households') { res.end(JSON.stringify({ data: { current, households: choices } })); return; }
    if (path === '/api/portal/households/current') { let body = ''; for await (const chunk of req) body += chunk; current = (JSON.parse(body) as { householdId: string }).householdId; res.end(JSON.stringify({ data: null })); return; }
    if (path === '/api/portal/context') {
      if (!current) { res.statusCode = 404; res.end(JSON.stringify({ error: { code: 'not_found' } })); return; }
      res.end(JSON.stringify({ data: current === household ? { role: 'payer', householdId: household, memberId: member } : { role: 'member', householdId: second, memberId: member } })); return;
    }
    if (path === '/api/portal/invitations/accept') { res.end(JSON.stringify({ data: { status: 'claimed' } })); return; }
    if (path === '/api/members/' + member) { res.end(JSON.stringify({ data: person })); return; }
    if (path.endsWith('/portal-logins')) { res.end(JSON.stringify({ data: revoked ? [] : [login], pagination: { limit: 20, offset: 0, total: revoked ? 0 : 1 },
      ...(awaiting ? { awaitingConfirmation: { email: 'a-long-joining-address-that-wraps@example.test' } } : {}) })); return; }
    if (path.endsWith('/portal-invitations')) { res.end(JSON.stringify({ data: { delivery: 'print', invitation: { userId, scope: 'member', memberId: member, expiresAt: '2026-11-04T12:00:00.000Z' }, invitationUrl: 'http://localhost/portal/claim#' + 'a'.repeat(64) } })); return; }
    if (req.method === 'DELETE') revoked = true;
    res.end(JSON.stringify({ data: null })); return;
  }
  if (path === '/access-fixture') { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><html lang="en"><head><title>Portal access</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/${cssName}"></head><body><div id="root"></div><script type="module" src="/access.js"></script></body></html>`); return; }
  if (path === '/access.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(resolve(output, 'access.js'))); return; }
  if (path.startsWith('/assets/')) { res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(resolve(dist, 'assets', path.split('/').at(-1)!))); return; }
  res.setHeader('Content-Type', 'text/html'); res.end(await readFile(resolve(dist, 'index.html')));
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
const profile = await mkdtemp(resolve(output, 'profile-'));
if (!profile.startsWith(output + sep)) throw new Error('Unexpected profile directory');
const origin = `http://127.0.0.1:${address.port}`, browser = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true });
const errors: string[] = [];
try {
  const page = await browser.newPage(); page.on('pageerror', (error: Error) => errors.push(error.message));
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const check = async (name: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button,input,select,a')].filter(element => !element.classList.contains('sr-only') && element.getClientRects().length && element.getBoundingClientRect().height < 44).map(element => element.textContent))).toEqual([]);
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true });
    };
    current = null; await page.goto(origin + '/portal/'); await expect(page.getByRole('heading', { name: 'Choose a household' })).toBeVisible();
    await check('picker');
    await page.getByRole('button', { name: /Second household/ }).click(); await expect(page.getByRole('heading', { name: 'Welcome to your member portal' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Household' })).toHaveValue(second); await check('switcher');
    await page.getByRole('combobox', { name: 'Household' }).selectOption(household); await expect(page.getByRole('combobox', { name: 'Household' })).toHaveValue(household);
    expect(current).toBe(household);
    if (width === 360) { await page.getByRole('button', { name: 'Menu' }).click(); await expect(page.getByRole('navigation')).toBeVisible(); }
    await check('shell');
    await page.evaluate(() => navigator.serviceWorker.ready);
    const cdp = await page.context().newCDPSession(page); const manifest = await cdp.send('Page.getAppManifest'); expect(manifest.errors).toEqual([]);
    expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);
    expect(await page.evaluate(() => caches.keys())).toEqual([]);
    await page.goto(origin + '/portal/claim#' + 'a'.repeat(64)); await expect(page.getByRole('heading', { name: 'Set up your portal login' })).toBeVisible();
    await expect(page).not.toHaveURL(/#/); await check('claim');
    await page.getByLabel('Password (12–128 characters)').fill('browser-password-123'); await page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(page.getByText('Your portal login is ready. Sign in to continue.')).toBeVisible();
    revoked = false; await page.goto(origin + '/access-fixture'); await expect(page.getByText(person.email)).toBeVisible(); await check('access');
    await page.getByRole('button', { name: 'Invite', exact: true }).click(); await check('invite');
    await page.getByRole('dialog').getByRole('button', { name: 'Invite', exact: true }).click(); await expect(page.getByText('Private invitation link')).toBeVisible(); await check('print');
    await page.getByRole('button', { name: 'Reset password', exact: true }).click(); await page.getByLabel('New password (12–128 characters)').fill('new-browser-password'); await check('reset');
    await page.getByRole('dialog').getByRole('button', { name: 'Reset password', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Revoke access', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Revoke access', exact: true }).click(); await expect(page.getByText('No portal logins yet')).toBeVisible();
    // A password-mode join awaiting confirmation: staff confirm with a printed payer invitation for its address.
    awaiting = true; await page.goto(origin + '/access-fixture'); await expect(page.getByText('Awaiting portal confirmation')).toBeVisible(); await check('awaiting');
    await page.getByRole('button', { name: 'Confirm and print invitation' }).click();
    await expect(page.getByLabel('Login email')).toHaveValue('a-long-joining-address-that-wraps@example.test');
    await expect(page.getByLabel('Access')).toHaveValue('payer'); await expect(page.getByLabel('Invitation delivery')).toHaveValue('print'); await check('confirm');
    await page.getByRole('dialog').getByRole('button', { name: 'Invite', exact: true }).click(); await expect(page.getByText('Private invitation link')).toBeVisible();
    awaiting = false;
  }
  expect(errors).toEqual([]); console.log('Passed: household picker and header switcher, portal shell, claim, access, invite/print/reset/revoke and join confirmation at 360 and 1280 px; no overflow; 44 px controls; axe A/AA; Chromium PWA installability; no offline caches.');
} finally { await browser.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await rm(profile, { recursive: true, force: true }); }
