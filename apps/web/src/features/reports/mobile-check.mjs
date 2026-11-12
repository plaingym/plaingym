// SPDX-License-Identifier: AGPL-3.0-only
/* global document, window */
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { attendanceFixture, membersFixture, revenueFixture, fixtureId } from './fixtures.ts';
const webRequire = createRequire(new URL('../../../package.json', import.meta.url));
const e2eRequire = createRequire(new URL('../../../../../e2e/package.json', import.meta.url));
const { build, preview } = webRequire('vite');
const { chromium, expect } = e2eRequire('@playwright/test');
const { default: AxeBuilder } = e2eRequire('@axe-core/playwright');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = new URL('../../../../../coverage/reports/', import.meta.url);
const outDir = fileURLToPath(new URL('fixture/', output));
const host = process.env.E2E_LOOPBACK ?? '127.0.0.1';
const url = `http://${host}:5199/src/features/reports/browser-fixture.html`;
const timeout = setTimeout(() => { console.error('Report browser check exceeded five minutes'); process.exit(1); }, 300000);
let server, browser;
try {
  await mkdir(output, { recursive: true });
  process.env.SOURCE_URL ||= 'https://github.com/plaingym/plaingym';
  await build({ root, build: { outDir, emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('./browser-fixture.html', import.meta.url)) } } });
  server = await preview({ root, build: { outDir }, preview: { host, port: 5199, strictPort: true } });
  browser = await chromium.launch({ headless: true });
  for (const width of [360, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.clock.setFixedTime(new Date('2026-11-10T12:00:00Z'));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let role = 'owner', mode = 'normal';
    const requested = [];
    const fixtures = { attendance: attendanceFixture, members: membersFixture, revenue: revenueFixture };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: {
        gym: { id: fixtureId, name: 'Gym', timezone: 'America/Los_Angeles', currency: 'USD', enabledModules: [] },
        session: { userId: fixtureId, displayName: 'Staff', roles: [role], member: false }, login: { password: true, magicLink: false },
      } } });
      const report = path.split('/').at(-1);
      if (!(report in fixtures)) return route.fulfill({ status: 404 });
      requested.push(report);
      if (mode === 'error') return route.fulfill({ status: 500, json: { error: { message: 'private database detail' } } });
      const data = structuredClone(fixtures[report]);
      if (report === 'attendance') data.buckets[0].programs[0].programName = '=Program ' + 'x'.repeat(160);
      if (report === 'revenue') data.currencies[0].buckets[0].groups[0].name = '@Plan ' + 'x'.repeat(160);
      if (mode === 'empty') { if (report === 'revenue') data.currencies = []; else data.buckets = []; }
      return route.fulfill({ json: { data } });
    });
    const check = async name => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const small = await page.locator('button:visible, input:visible, select:visible').evaluateAll(elements => elements
        .filter(el => { const rect = el.getBoundingClientRect(); return rect.width < 44 || rect.height < 44; }).map(el => el.outerHTML));
      expect(small).toEqual([]);
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
      expect(errors).toEqual([]);
      await page.screenshot({ path: fileURLToPath(new URL(`${width}-${name}.png`, output)), fullPage: true });
    };
    await page.goto(url); await page.getByRole('table').waitFor(); await check('attendance');
    await page.getByLabel('Program', { exact: true }).selectOption(fixtureId); await check('attendance-filter');
    await page.getByLabel('Attendance period').selectOption('week');
    await expect(page.getByLabel('Program', { exact: true })).toHaveValue('all'); await check('attendance-week');
    for (const name of ['Members', 'Revenue']) {
      await page.getByRole('tab', { name, exact: true }).click();
      await page.getByRole('table').first().waitFor(); await check(name.toLowerCase());
    }
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV: Revenue data (USD)', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('revenue-2025-12-2026-11-USD.csv');
    const bytes = await readFile(await download.path());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString('utf8')).toContain('"\'@Plan ');
    expect(bytes.toString('utf8')).toContain('"-10.00"');
    for (const state of ['error', 'empty']) {
      mode = state; await page.reload();
      for (const name of ['Attendance', 'Members', 'Revenue']) {
        await page.getByRole('tab', { name, exact: true }).click();
        if (state === 'error') { await page.getByRole('alert').waitFor(); await expect(page.getByText('private database detail')).toHaveCount(0); }
        else await page.getByText('No activity in this range').waitFor();
        await check(`${name.toLowerCase()}-${state}`);
      }
    }
    role = 'coach'; mode = 'normal'; requested.length = 0; await page.reload();
    await page.getByRole('table').waitFor(); expect(await page.getByRole('tab').count()).toBe(1);
    expect(requested).toEqual(['attendance']); await check('coach');
    role = 'front_desk'; requested.length = 0; await page.reload();
    await page.getByText('You do not have permission to view reports.').waitFor(); expect(requested).toEqual([]); await check('front-desk');
    await context.close();
  }
  console.log('Reports passed at 360px and 1280px: all three views, program filtering, week selection, actual CSV download, empty and error states, coach/front-desk access, overflow, 44px targets and axe.');
} finally {
  clearTimeout(timeout);
  await browser?.close();
  if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
