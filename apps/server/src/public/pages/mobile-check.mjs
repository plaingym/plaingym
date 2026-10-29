// SPDX-License-Identifier: AGPL-3.0-only
/* global document, innerWidth, getComputedStyle */
/* eslint-disable no-restricted-syntax -- Standalone browser QA resolves the isolated e2e dependency installation; the server never imports this file. */
// Run from the repository root with the server's tsx runner; uses the installed Edge browser.
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { createApp } from '../../core/app.ts';
import { createPublicRoutes } from './pages.routes.ts';
import { authorize } from '../../areas/staff/auth.permissions.ts';
import { buildLinkStyles } from '../links/styles.build.mjs';
import { demoSignaturePng } from '../../demo/seed/waivers-image.ts';

const require = createRequire(new URL('../../../../../e2e/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const { default: AxeBuilder } = require('@axe-core/playwright');
const output = new URL('../../../../../coverage/public-pages/', import.meta.url);
await mkdir(output, { recursive: true });
await buildLinkStyles(new URL('styles.css', output).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const css = await readFile(new URL('styles.css', output), 'utf8');
const gymId = '01900000-0000-7000-8000-000000000001';
const templates = [{ id: '01900000-0000-7000-8000-000000000002', name: 'Participation waiver', kind: 'waiver', version: 1,
  body: 'Read these terms before training.\n' + 'LongWord'.repeat(40), retiredAt: null, createdAt: '2026-10-29T12:00:00Z' }];
const calls = [];
const service = {
  async config() { return { data: { gym: { name: 'North Community Academy', revision: 1, logoKey: null, primaryColor: '#ffff00' }, dropInFee: { amountCents: 2500, currency: 'CAD' } } }; },
  async required() { return templates; },
  async trial(_gym, body) { calls.push({ kind: 'trial', body }); return { data: { status: 'received' } }; },
  async admit(_gym, body) { calls.push({ kind: 'admit', body }); return { data: body.signatures.map(s => ({ templateId: s.templateId, templateVersion: s.templateVersion,
    signatureImageKey: gymId + '/waivers/01900000-0000-7000-8000-000000000003/signatures/test.png', signatureImageHash: 'a'.repeat(64) })) }; },
  async dropIn(_gym, body) { calls.push({ kind: 'drop-in', body }); return { data: { status: 'received' } }; },
};
const app = createApp({ skipSetup: true, authorize, contributions: { routes: createPublicRoutes({ service, stylesheet: async () => css }) },
  resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
  session: async (_c, next) => { await next(); } });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const base = 'http://127.0.0.1:' + server.address().port;
const errors = [];
const check = async (page, name) => {
  expect(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => e.outerHTML.slice(0, 160)))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('input:not([type=checkbox]):visible, select:visible, button:visible, a:visible').evaluateAll(elements => elements.filter(e => {
    const r = e.getBoundingClientRect(); return r.width < 44 || r.height < 44;
  }).map(e => e.outerHTML))).toEqual([]);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  await page.screenshot({ path: new URL(name + '.png', output).pathname.replace(/^\/([A-Za-z]:)/, '$1'), fullPage: true });
};
async function fill(page) {
  for (const [name, value] of Object.entries({ firstName: 'New', lastName: 'Visitor', dateOfBirth: '1990-01-02', contactName: 'Alex Contact', email: 'new@example.invalid' })) await page.locator('[name=' + name + ']').fill(value);
}
try {
  for (const width of [360, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
    page.setDefaultTimeout(10_000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/trial'); await check(page, width + '-trial');
    expect(await page.locator('button[type=submit]').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 0)');
    await fill(page); await page.locator('button[type=submit]').click(); await page.waitForURL('**/trial/received'); await check(page, width + '-trial-received');
    await page.goto(base + '/drop-in'); await fill(page); await page.locator('[name=waiver-0-name]').fill('New Visitor'); await page.locator('[name=waiver-0-consent]').check();
    await page.locator('button[type=submit]').click(); await expect(page.locator('#feedback')).toContainText('draw or choose');
    const canvas = page.locator('canvas'), bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + 25, bounds.y + 35); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width - 25, bounds.y + 90, { steps: 12 }); await page.mouse.up();
    await check(page, width + '-drop-in');
    await page.locator('button[type=submit]').click(); await page.waitForURL('**/drop-in/received'); await check(page, width + '-drop-in-received');
    await page.goto(base + '/drop-in'); await fill(page); await page.locator('[name=waiver-0-name]').fill('Parent Contact');
    await page.locator('[name=waiver-0-kind]').selectOption('guardian'); await page.locator('[name=waiver-0-relationship]').fill('Parent');
    await page.locator('[name=waiver-0-consent]').check(); await page.locator('input[type=file]').setInputFiles({ name: 'signature.png', mimeType: 'image/png', buffer: demoSignaturePng() });
    await page.locator('button[type=submit]').click(); await page.waitForURL('**/drop-in/received');
    await context.close();
  }
  expect(errors).toEqual([]);
  expect(calls.filter(c => c.kind === 'trial')).toHaveLength(2);
  expect(calls.filter(c => c.kind === 'drop-in')).toHaveLength(4);
  expect(calls.filter(c => c.kind === 'admit').every(c => c.body.signatures[0].pngBase64.startsWith('iVBOR'))).toBe(true);
  console.log('360/1280 px: trial, drop-in, drawn/file signatures, confirmation, CSS theme, touch targets and axe passed.');
} finally { await browser.close(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
