// SPDX-License-Identifier: AGPL-3.0-only
// Build the web app first, then run with Node from the repository root. Uses isolated component fixtures and real styles.
import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const { chromium, expect } = await import(pathToFileURL(resolve('e2e/node_modules/@playwright/test/index.mjs')).href);
const { default: AxeBuilder } = await import(pathToFileURL(resolve('e2e/node_modules/@axe-core/playwright/dist/index.mjs')).href);
const require = createRequire(resolve('apps/server/package.json'));
const { build } = await import(pathToFileURL(require.resolve('esbuild')).href);
const output = resolve('coverage/kiosk/browser'), dist = resolve('apps/web/dist');
await mkdir(output, { recursive: true });
const id = '00000000-0000-7000-8000-000000000001';
const device = { id, name: 'Reception tablet', createdAt: '2026-11-01T12:00:00Z', lastSeenAt: null, revokedAt: null };
const code = 'pgci1_' + 'a'.repeat(43), token = 'isolated-browser-fixture-token';
const bootstrap = { gym: { id, name: 'Fixture gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
  session: { userId: id, displayName: 'Dana', roles: [], member: true }, login: { password: true, magicLink: false } };
const bundle = await build({ stdin: { contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {ShellServicesContext} from './src/app/context.tsx';
import {KioskApp} from './src/features/kiosk/kiosk.tsx';
import {KioskDevicesSettings} from './src/features/kiosk-devices/settings.tsx';
import {CheckinCodePanel} from './src/features/kiosk/qr.member-tab.tsx';
import {PortalCheckinPage} from './src/features/portal/checkin/page.tsx';
const cache = new QueryClient({defaultOptions:{queries:{retry:false}}});
cache.setQueryData(['portal', '${id}', '${id}', 'households'], {current:'${id}', households:[{householdId:'${id}',name:'Dana',role:'payer'}]});
const own = data => ({data, householdId:'${id}'});
const client = {context:async()=>own({householdId:'${id}',memberId:'${id}',role:'payer'}), members:async()=>own([{id:'${id}',name:'Dana Example'}]), checkinCode:async()=>own({memberId:'${id}',code:'${code}',version:1,revision:1})};
const path = location.pathname;
const view = path === '/kiosk' ? <KioskApp/> : path === '/portal' ? <main><PortalCheckinPage client={client}/></main> :
  <main className="mx-auto w-full max-w-3xl min-w-0 p-4"><h1 className="mb-4 text-2xl">{path === '/devices' ? 'Settings' : 'Dana Example'}</h1>{path === '/devices' ? <KioskDevicesSettings/> : <CheckinCodePanel gymId="${id}" memberId="${id}"/>}</main>;
createRoot(document.getElementById('root')).render(<QueryClientProvider client={cache}><ShellServicesContext.Provider value={{loadBootstrap:async()=>(${JSON.stringify(bootstrap)})}}>{view}</ShellServicesContext.Provider></QueryClientProvider>);
`, resolveDir: resolve('apps/web'), sourcefile: 'kiosk-browser.tsx', loader: 'tsx' }, bundle: true, write: false,
  format: 'esm', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const css = (await readdir(resolve(dist, 'assets'))).find(name => name.endsWith('.css'));
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return; }
  if (path === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(await readFile(resolve(dist, 'assets', css))); return; }
  if (path.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (path === '/api/kiosk/devices') {
      res.end(JSON.stringify(req.method === 'POST' ? { data: { device, token } } : { data: [device], pagination: { limit: 20, offset: 0, total: 1 } })); return;
    }
    if (path.endsWith('/checkin-code')) { res.end(JSON.stringify({ data: { memberId: id, code, version: 1, revision: 1 } })); return; }
    if (path === '/api/demo') { res.end(JSON.stringify({ data: { mode: 'disabled' } })); return; }
    res.statusCode = 404; res.end('{}'); return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html lang="en"><head><title>Kiosk browser check</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
});
await new Promise(done => server.listen(0, process.env.E2E_LOOPBACK ?? '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? 'msedge', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // A deterministic camera-free device, independent of the workstation's hardware or browser permissions.
  await page.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { configurable: true,
    value: { getUserMedia: async () => { throw new Error('No camera expected'); }, enumerateDevices: async () => [] } }));
  const origin = `http://${process.env.E2E_LOOPBACK ?? '127.0.0.1'}:${server.address().port}`;
  const check = async (name, width) => {
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), name).toBe(true);
    expect(await page.locator('button,input,select').evaluateAll(elements => elements.filter(element => element.getClientRects().length
      && element.getBoundingClientRect().height < 44).map(element => element.outerHTML)), name).toEqual([]);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations, name).toEqual([]);
    await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true });
  };
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin + '/kiosk'); await expect(page.getByLabel('Device token')).toBeVisible(); await check('device-setup', width);
    await page.evaluate(() => { globalThis.location.hash = 'token=first-token'; });
    await expect(page.getByRole('button', { name: 'Scan a QR code' })).toBeVisible(); await check('kiosk-choice', width);
    await page.getByRole('button', { name: 'Name and PIN' }).click(); await check('kiosk-pin', width);
    await page.evaluate(() => { globalThis.location.hash = 'token=replacement-token'; });
    await expect(page.getByRole('button', { name: 'Scan a QR code' })).toBeVisible(); expect(new URL(page.url()).hash).toBe('');
    await page.getByRole('button', { name: 'Scan a QR code' }).click();
    await expect(page.getByText(/can't scan a QR code/)).toBeVisible(); await check('kiosk-no-camera', width);
    await page.goto(origin + '/devices'); await expect(page.getByText('Reception tablet', { exact: true })).toBeVisible();
    await page.getByLabel('Device name').fill('Tablet'); await page.getByRole('button', { name: 'Register device' }).click();
    await expect(page.getByAltText('QR code of the kiosk setup link')).toBeVisible(); await check('setup-link', width);
    await page.getByRole('button', { name: 'Show token' }).click(); await expect(page.getByRole('button', { name: 'Hide token' })).toBeVisible(); await check('setup-token', width);
    await page.goto(origin + '/staff'); await expect(page.getByAltText('Member check-in QR code')).toBeVisible(); await check('member-code', width);
    await page.goto(origin + '/portal'); await expect(page.getByAltText('QR check-in code for Dana Example')).toBeVisible(); await check('portal-code', width);
    await page.goto(origin + '/kiosk'); await page.evaluate(() => localStorage.clear());
  }
  expect(errors).toEqual([]);
  console.log('24 kiosk browser layout/accessibility checks passed at 360, 768 and 1280 px; screenshots: ' + output);
} finally {
  await browser?.close(); await new Promise(done => server.close(done));
}
