// SPDX-License-Identifier: AGPL-3.0-only
/* global document, innerWidth, getComputedStyle */
/* eslint-disable no-restricted-syntax -- Standalone browser QA resolves the isolated e2e dependency installation; the server never imports this file. */
// Run from the repository root with the server's tsx runner; uses the installed Edge browser.
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { createApp } from '../../core/app.ts';
import { createJoinRoutes } from './join.routes.ts';
import { joinContinuations } from './join.continuation.ts';
import { createPublicRoutes } from './pages.routes.ts';
import { authorize } from '../../areas/staff/auth.permissions.ts';
import { buildLinkStyles } from '../links/styles.build.mjs';
import { demoSignaturePng } from '../../demo/seed/waivers-image.ts';

const require = createRequire(new URL('../../../../../e2e/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const { default: AxeBuilder } = require('@axe-core/playwright');
const output = new URL('../../../../../coverage/join-pages/', import.meta.url);
await mkdir(output, { recursive: true });
await buildLinkStyles(new URL('styles.css', output).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const css = await readFile(new URL('styles.css', output), 'utf8');
const gymId = '01900000-0000-7000-8000-000000000001', linkId = '01900000-0000-7000-8000-000000000009';
const gym = { name: 'North Community Academy', revision: 1, logoKey: null, primaryColor: '#ffff00' };
const plans = [
  { id: '01900000-0000-7000-8000-000000000004', name: 'Adult unlimited monthly', amountCents: 15000, currency: 'CAD', interval: 'monthly', signupFeeCents: 5000, trialDays: 0, commitmentMonths: 12, revision: 1 },
  { id: '01900000-0000-7000-8000-000000000005', name: 'Youth annual', amountCents: 90000, currency: 'CAD', interval: 'annual', signupFeeCents: 0, trialDays: 0, commitmentMonths: null, revision: 1 },
];
const templates = ['Participation waiver', 'Code of conduct'].map((name, i) => ({ id: `01900000-0000-7000-8000-00000000000${i + 2}`, name, kind: 'waiver', version: 1,
  body: 'Read these terms before training.\n' + 'LongWord'.repeat(40), retiredAt: null, createdAt: '2026-10-29T12:00:00Z' }));
const calls = [];
let state = 'pending', passwordMode = false;
const service = {
  async branding() { return gym; },
  async ready() { return templates; },
  async plans() { return { data: plans, pagination: { limit: 100, offset: 0, total: plans.length } }; },
  async joinablePlan(_gym, id) { const plan = plans.find(p => p.id === id); if (!plan) throw Object.assign(new Error('missing'), { code: 'not_found' }); return plan; },
  async admit(_gym, body) { calls.push({ kind: 'admit', body }); return { data: body.members.map((member, i) => member.signatures.map(s => ({ templateId: s.templateId,
    templateVersion: s.templateVersion, signatureImageKey: `${gymId}/waivers/01900000-0000-7000-8000-00000000001${i}/signatures/test.png`, signatureImageHash: 'a'.repeat(64) }))) }; },
  async join(_gym, body) { calls.push({ kind: 'join', body }); return { linkId }; },
  async checkout() { calls.push({ kind: 'checkout' }); return base + '/join/return'; },
  async state() { return { status: state, householdId: '01900000-0000-7000-8000-000000000020' }; },
  async passwordMode() { return passwordMode; },
  async resend() { calls.push({ kind: 'resend' }); },
  async passwordLogin() { calls.push({ kind: 'password' }); return { status: 'invited', token: 'f'.repeat(64) }; },
};
const publicService = { async config() { return { data: { gym, dropInFee: null } }; } };
const app = createApp({ skipSetup: true, authorize, contributions: { routes: [...createJoinRoutes({ service, continuations: joinContinuations(new Uint8Array(32).fill(5)) }),
  ...createPublicRoutes({ service: publicService, stylesheet: async () => css })] },
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
async function fill(page, drawn) {
  for (const [name, value] of Object.entries({ contactName: 'Pat Payer', email: 'payer@example.invalid', 'member-0-firstName': 'Avery', 'member-0-lastName': 'Joiner',
    'member-0-dateOfBirth': '1990-01-02', 'member-1-firstName': 'Kai', 'member-1-lastName': 'Joiner', 'member-1-dateOfBirth': '2016-05-06' })) await page.locator(`[name="${name}"]`).fill(value);
  for (const member of [0, 1]) for (const doc of [0, 1]) {
    const prefix = `waiver-${member}-${doc}`;
    if (member === 1) { await page.locator(`[name="${prefix}-kind"]`).selectOption('guardian'); await page.locator(`[name="${prefix}-relationship"]`).fill('Parent'); }
    await page.locator(`[name="${prefix}-name"]`).fill(member ? 'Pat Payer' : 'Avery Joiner'); await page.locator(`[name="${prefix}-consent"]`).check();
    if (!drawn) { await page.locator(`[name="${prefix}-image"]`).setInputFiles({ name: 'signature.png', mimeType: 'image/png', buffer: demoSignaturePng() }); continue; }
    const canvas = page.locator(`fieldset[data-member="${member}"] fieldset[data-waiver]`).nth(doc).locator('canvas');
    await canvas.scrollIntoViewIfNeeded(); const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + 25, bounds.y + 35); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width - 25, bounds.y + 90, { steps: 12 }); await page.mouse.up();
  }
}
try {
  for (const width of [360, 1280]) {
    state = 'pending'; passwordMode = false;
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
    page.setDefaultTimeout(10_000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/join'); await check(page, width + '-plans');
    expect(await page.locator('a', { hasText: 'Choose Adult' }).evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 0)');
    await page.locator('a', { hasText: 'Choose Adult' }).click(); await page.waitForURL('**/join?plan=*');
    await page.locator('#members').selectOption('2'); await page.locator('button', { hasText: 'Update' }).click(); await page.waitForURL('**members=2');
    await check(page, width + '-form');
    await fill(page, false); await page.locator('[name="waiver-0-0-image"]').setInputFiles([]);
    await page.locator('button[type=submit]', { hasText: 'Continue to payment' }).click(); await expect(page.locator('#feedback')).toContainText('draw or choose');
    await fill(page, true); await check(page, width + '-form-signed');
    await page.locator('button[type=submit]', { hasText: 'Continue to payment' }).click(); await page.waitForURL('**/join/return');
    await check(page, width + '-confirming');
    await page.goto(base + '/join/cancelled'); await check(page, width + '-cancelled');
    state = 'active'; await page.goto(base + '/join/return'); await check(page, width + '-welcome-email');
    await page.locator('button', { hasText: 'Send the sign-in link again' }).click(); await page.waitForURL('**/join/sign-in'); await check(page, width + '-resent');
    passwordMode = true; await page.goto(base + '/join/return'); await check(page, width + '-welcome-password');
    await page.locator('button', { hasText: 'Set up my portal login' }).click(); await page.waitForURL(/\/portal\/claim#f{64}$/);
    const fresh = await browser.newContext({ viewport: { width, height: 900 } }), lost = await fresh.newPage();
    await lost.goto(base + '/join/return'); await check(lost, width + '-missing'); await fresh.close();
    await context.close();
  }
  // Without JavaScript the native multipart form posts PNG files and offers a same-origin link onward.
  const noScript = await browser.newContext({ viewport: { width: 360, height: 900 } }), page = await noScript.newPage();
  // Without the enhancement script (axe still needs page JavaScript); the canvases stay blank and unused.
  await noScript.route('**/join/client.js', route => route.abort()); page.setDefaultTimeout(10_000);
  state = 'pending'; await page.goto(base + `/join?plan=${plans[0].id}&members=2`); await fill(page, false);
  await page.locator('button[type=submit]', { hasText: 'Continue to payment' }).click(); await page.waitForURL('**/join');
  await check(page, '360-continue-native'); await page.locator('a', { hasText: 'Pay securely' }).click(); await page.waitForURL('**/join/return');
  await noScript.close();
  expect(errors).toEqual([]);
  const joins = calls.filter(c => c.kind === 'join');
  expect(joins).toHaveLength(3);
  expect(joins.every(c => c.body.members.length === 2 && c.body.members[1].waivers.every(w => w.signer.kind === 'guardian' && w.signer.relationship === 'Parent'))).toBe(true);
  expect(calls.filter(c => c.kind === 'admit').every(c => c.body.members.every(m => m.signatures.every(s => s.pngBase64.startsWith('iVBOR'))))).toBe(true);
  expect(calls.filter(c => c.kind === 'checkout')).toHaveLength(3);
  console.log('360/1280 px: plans, two-person form, drawn/file signatures, confirming, cancelled, welcome (email and password), resend, missing, native form, touch targets and axe passed.');
} finally { await browser.close(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
