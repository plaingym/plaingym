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
const output = new URL('../../../../../coverage/leads/', import.meta.url);
const outDir = fileURLToPath(new URL('fixture/', output));
const host = process.env.E2E_LOOPBACK ?? '127.0.0.1';
const url = `http://${host}:5201/src/features/leads/browser-fixture.html`;
const timeout = setTimeout(() => { console.error('Leads browser check exceeded five minutes'); process.exit(1); }, 300000);
const id = n => `0194a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const long = 'Averylongsurname'.repeat(8);
const lead = (n, stage, extra = {}) => ({ memberId: id(n), householdId: id(100 + n), firstName: 'Lead', lastName: n === 1 ? long : 'No' + n,
  email: null, phone: null, status: 'prospect', source: 'trial_form', stage, nextFollowUpOn: null, lastContactedAt: null,
  createdAt: '2026-11-01T12:00:00.000Z', revision: n, ...extra });
const leads = [lead(1, 'new'), lead(2, 'new', { source: 'walk_in' }), lead(3, 'contacted', { nextFollowUpOn: '2026-11-15' }),
  lead(4, 'trial_booked'), lead(5, 'trial_attended'), lead(6, 'lost', { source: null })];
let server, browser;
try {
  await mkdir(output, { recursive: true });
  process.env.SOURCE_URL ||= 'https://github.com/plaingym/plaingym';
  await build({ root, build: { outDir, emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('./browser-fixture.html', import.meta.url)) } } });
  server = await preview({ root, build: { outDir }, preview: { host, port: 5201, strictPort: true } });
  browser = await chromium.launch({ headless: true });
  for (const width of [360, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname, query = new URL(request.url()).searchParams;
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: {
        gym: { id: id(999), name: 'Gym', timezone: 'America/New_York', currency: 'USD', enabledModules: [] },
        session: { userId: id(998), displayName: 'Staff', roles: ['front_desk'], member: false }, login: { password: true, magicLink: false },
      } } });
      if (path === '/api/leads') {
        const rows = leads.filter(row => row.stage === query.get('stage'));
        return route.fulfill({ json: { data: rows, pagination: { limit: 25, offset: 0, total: rows.length },
          counts: { new: 0, contacted: 0, trial_booked: 0, trial_attended: 0, won: 0, lost: 0 } } });
      }
      if (path === '/api/schedule/sessions') return route.fulfill({ json: { data: [], pagination: { limit: 100, offset: 0, total: 0 } } });
      return route.fulfill({ status: 404 });
    });
    const check = async name => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const small = await page.locator('button:visible, select:visible, a:visible, input:visible:not([type=checkbox]), label:has(input[type=checkbox]):visible').evaluateAll(elements => elements
        .filter(el => { const rect = el.getBoundingClientRect(); return rect.width < 44 || rect.height < 44; }).map(el => el.outerHTML.slice(0, 200)));
      expect(small).toEqual([]);
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
      expect(errors).toEqual([]);
      await page.screenshot({ path: fileURLToPath(new URL(`${width}-${name}.png`, output)), fullPage: true });
    };
    await page.goto(url);
    await page.getByRole('heading', { name: 'New (2)' }).waitFor();
    await check('board');
    await page.getByRole('checkbox', { name: 'Show lost' }).check();
    await page.getByRole('heading', { name: 'Lost (1)' }).waitFor();
    await check('lost');
    await page.getByRole('button', { name: /^Mark Lead No2 lost$/ }).click();
    await page.getByRole('dialog').getByLabel('Reason').waitFor();
    await check('lost-dialog');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: /^Book a trial class for Lead No2$/ }).click();
    await page.getByRole('dialog').getByText('No upcoming bookable classes on this date.').waitFor();
    await check('book-dialog');
    await context.close();
  }
  console.log('Leads screens pass at 360 px and 1280 px.');
} finally {
  clearTimeout(timeout);
  await browser?.close();
  await server?.close?.();
}
