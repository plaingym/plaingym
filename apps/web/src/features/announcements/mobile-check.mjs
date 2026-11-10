// SPDX-License-Identifier: AGPL-3.0-only
/* global document, window */
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const webRequire = createRequire(new URL('../../../package.json', import.meta.url));
const e2eRequire = createRequire(new URL('../../../../../e2e/package.json', import.meta.url));
const { build, preview } = webRequire('vite');
const { chromium, expect } = e2eRequire('@playwright/test');
const { default: AxeBuilder } = e2eRequire('@axe-core/playwright');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = new URL('../../../../../coverage/announcements/', import.meta.url);
const outDir = fileURLToPath(new URL('fixture/', output));
await mkdir(output, { recursive: true });
process.env.SOURCE_URL ||= 'https://github.com/plaingym/plaingym';
await build({ root, build: { outDir, emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('./browser-fixture.html', import.meta.url)) } } });
const server = await preview({ root, build: { outDir }, preview: { host: process.env.E2E_LOOPBACK ?? '127.0.0.1', port: 5198, strictPort: true } });
let browser;
const timeout = setTimeout(() => { console.error('Announcement screen check exceeded three minutes'); process.exit(1); }, 180000);
const id = '01900000-0000-7000-8000-000000000001', senderId = '01900000-0000-7000-8000-000000000002';
const announcement = { id, createdBy: senderId, subject: 'Winter classes', body: 'Classes resume Monday.', audience: { statuses: ['active', 'trial', 'frozen'], programIds: [] },
  recipientCount: 3, status: 'sent', createdAt: '2026-11-10T00:00:00Z', completedAt: '2026-11-10T00:01:00Z', sent: 1, failed: 1, skipped: 1 };
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  for (const width of [360, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
    page.setDefaultTimeout(10000);
    let refusal = null, submitted = 0;
    const generations = [];
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const list = data => ({ data, pagination: { offset: 0, limit: 100, total: data.length } });
      if (path === '/api/programs') return route.fulfill({ json: list([{ id, gymId: id, name: 'Adults ' + 'x'.repeat(160), rankSystemId: null, active: true, revision: 1, createdAt: announcement.createdAt }]) });
      if (path === '/api/staff/profiles') return route.fulfill({ json: list([{ id, userId: senderId, memberId: null, displayName: 'Owner ' + 'x'.repeat(160), bio: null, photoKey: null, rank: null, isPublic: false, revision: 1, createdAt: announcement.createdAt }]) });
      if (path === '/api/announcements') return route.fulfill({ json: list([{ ...announcement, subject: 'Winter ' + 'x'.repeat(150) }]) });
      if (refusal) return route.fulfill({ status: 409, json: { error: { code: 'conflict', details: { reason: [refusal] } } } });
      if (path.endsWith('/preview')) return route.fulfill({ json: { data: { recipientCount: 3 } } });
      if (path.endsWith('/test')) return route.fulfill({ json: { data: { sent: true } } });
      if (path.endsWith('/send')) {
        submitted++; generations.push(request.postDataJSON().sendGeneration);
        await new Promise(resolve => setTimeout(resolve, 200));
        return route.fulfill({ json: { data: announcement } });
      }
      return route.fulfill({ status: 404 });
    });
    const check = async name => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const small = await page.locator('button:visible, a:visible, input:not([type=checkbox]):visible, textarea:visible, label:has(input[type=checkbox]):visible').evaluateAll(elements => elements
        .filter(el => !document.querySelector('dialog[open]') || el.closest('dialog'))
        .filter(el => { const r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).map(el => el.outerHTML));
      expect(small).toEqual([]);
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
      await page.screenshot({ path: fileURLToPath(new URL(`${width}-${name}.png`, output)), fullPage: true });
      const dialogBody = page.locator('[data-dialog-body]');
      if (await dialogBody.count()) {
        await dialogBody.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await page.screenshot({ path: fileURLToPath(new URL(`${width}-${name}-actions.png`, output)), fullPage: true });
        await dialogBody.evaluate(element => { element.scrollTop = 0; });
      }
    };
    await page.goto(`http://${process.env.E2E_LOOPBACK ?? '127.0.0.1'}:5198/src/features/announcements/browser-fixture.html`);
    await page.getByText('Owner ' + 'x'.repeat(160)).waitFor(); await check('history');
    await page.getByRole('button', { name: 'New announcement' }).click();
    await page.getByLabel('Subject', { exact: true }).fill('Schedule ' + 'x'.repeat(140));
    await page.getByLabel('Message', { exact: true }).fill('Classes resume Monday.\nhttps://example.test/' + 'x'.repeat(160) + '\n<script>plain text</script>');
    await check('compose');
    refusal = 'disabled'; await page.getByRole('button', { name: 'Preview announcement', exact: true }).click();
    await page.getByText(/Member email is switched off/).waitFor(); await check('disabled');
    refusal = 'no_smtp'; await page.getByRole('button', { name: 'Preview announcement', exact: true }).click();
    await page.getByText(/Email is not configured/).waitFor(); await check('smtp');
    refusal = null; await page.getByRole('button', { name: 'Preview announcement', exact: true }).click();
    await page.getByRole('region', { name: 'Member message preview' }).waitFor(); await check('preview');
    await page.getByRole('button', { name: 'Send me a test' }).click();
    await page.getByText('Test sent to your email address. No members received it.').waitFor(); await check('test');
    await page.getByRole('button', { name: 'Continue to confirmation' }).click(); await check('confirm');
    // Two synchronous clicks exercise the guard before React rerenders the disabled control.
    await page.getByRole('button', { name: 'Send to 3 members' }).evaluate(button => { button.click(); button.click(); });
    await page.getByText('Announcement accepted. Delivery progress appears in history.').waitFor();
    expect(submitted).toBe(1); expect(generations).toHaveLength(1); await check('accepted');
    await context.close();
  }
  console.log('Announcement screens passed at 360px and 1280px: history, compose, both refusals, preview, test, confirm, double click, overflow, 44px targets and axe.');
} finally {
  clearTimeout(timeout);
  await browser?.close();
  await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
