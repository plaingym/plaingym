// SPDX-License-Identifier: AGPL-3.0-only
/* global document, window */
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../../../../e2e/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const { default: AxeBuilder } = require('@axe-core/playwright');
const output = new URL('../../../../../coverage/campaigns/', import.meta.url); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const id = '01900000-0000-7000-8000-000000000001', householdId = '01900000-0000-7000-8000-000000000002';
const createdAt = '2026-10-26T12:00:00Z';
const detail = { campaign: { id, name: 'October onboarding', purpose: 'onboarding', createdBy: null, reminderSchedule: [3, 7], completedAt: null, createdAt },
  progress: { total: 1, pending: 1, completed: 0, expired: 0, revoked: 0 } };
try {
  for (const width of [360, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
    page.setDefaultTimeout(10000);
    let fail = false, completed = false;
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), list = data => ({ data, pagination: { limit: 20, offset: 0, total: data.length } });
      if (url.pathname === '/api/households') return route.fulfill({ json: list([{ id: householdId, name: 'Chen household with a long descriptive name',
        email: 'payer.with.a.long.address@example.test', phone: null, address: {}, revision: 1, createdAt }]) });
      if (url.pathname.endsWith('/payment-methods')) return route.fulfill({ json: list([]) });
      if (request.method() === 'POST') {
        if (fail) return route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } });
        if (url.pathname.endsWith('/remind')) return route.fulfill({ json: { data: { queued: 1 } } });
        expect(request.postDataJSON()).toMatchObject({ purpose: 'update_card', recipients: [{ householdId }] });
        return route.fulfill({ json: { data: detail } });
      }
      if (url.pathname.endsWith('/recipients')) return route.fulfill({ json: list(completed ? [] : [{ state: 'pending', link: { id, householdId, campaignId: id,
        purpose: 'onboarding', invoiceId: null, memberId: null, expiresAt: '2026-11-26T12:00:00Z', usedAt: null, revokedAt: null, createdBy: null, createdAt } }]) });
      if (url.pathname === '/api/link-campaigns') return route.fulfill({ json: list([detail]) });
      return route.fulfill({ json: { data: completed ? { ...detail, progress: { ...detail.progress, pending: 0, completed: 1 } } : detail } });
    });
    const check = async name => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const small = await page.locator('button:visible, input:not([type=checkbox]):visible, select:visible').evaluateAll(elements => elements
        .filter(el => !document.querySelector('dialog[open]') || el.closest('dialog'))
        .filter(el => { const r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).map(el => el.outerHTML));
      expect(small).toEqual([]);
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
      await page.screenshot({ path: fileURLToPath(new URL(`${width}-${name}.png`, output)), fullPage: true });
    };
    await page.goto((process.argv[2] ?? 'http://127.0.0.1:5197') + '/src/features/campaigns/browser-fixture.html');
    await page.getByRole('button', { name: 'View October onboarding' }).waitFor(); await check('list');
    await page.getByRole('button', { name: 'New campaign' }).click();
    await page.getByLabel('Campaign name').fill('Card collection'); await page.getByLabel('Purpose').selectOption('update_card');
    await page.getByLabel('Links expire', { exact: true }).fill('2026-11-26');
    await page.getByRole('checkbox', { name: 'Needs a card' }).check();
    await page.getByRole('checkbox', { name: /Chen household/ }).check(); await check('editor');
    fail = true; await page.getByRole('button', { name: 'Create and send' }).click(); await page.getByRole('dialog').getByRole('alert').waitFor(); await check('error');
    fail = false; await page.getByRole('button', { name: 'Create and send' }).click(); await page.getByRole('button', { name: 'Remind pending households' }).waitFor();
    await expect(page.getByText('Chen household with a long descriptive name')).toBeVisible(); await check('recipients');
    await page.getByRole('button', { name: 'Remind pending households' }).click(); await expect(page.getByRole('status')).toContainText('Pending recipients queued: 1');
    completed = true; await page.getByLabel("Who's left?").selectOption('completed'); await expect(page.getByText('No recipients in this state')).toBeVisible(); await check('empty');
    await context.close();
  }
  console.log('Campaign screens: 360px and 1280px, create/detail/remind/error/empty flows, 44px controls, overflow and axe passed.');
} finally { await browser.close(); }
