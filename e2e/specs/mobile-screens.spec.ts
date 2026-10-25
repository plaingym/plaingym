// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { expect, gymOrigin, test, type Install, type Person, type RecordId } from '../support.js';

const screens = ['/admin', '/admin/members', '/admin/schedule', '/admin/ranks', '/admin/staff', '/admin/imports', '/admin/settings'];
const browserZone = 'Pacific/Honolulu';
// Wall-clock reads through Intl, so this independent suite never loads application modules or their dependencies.
function wall(instant: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(instant).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
const localDate = (instant: Date, timeZone: string) => wall(instant, timeZone).date;
/** Day of the week of a `YYYY-MM-DD` date, 0 (Sunday) to 6 (Saturday). */
const weekday = (date: string) => new Date(date + 'T00:00:00Z').getUTCDay();
const viewports = [
  { name: 'phone', viewport: { width: 360, height: 740 }, hasTouch: true },
  { name: 'desktop', viewport: { width: 1280, height: 800 }, hasTouch: false },
] as const;
interface Session extends RecordId { templateId: string | null; startsAt: string; endsAt: string }

async function noHorizontalScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(scrollWidth, 'page scrolls horizontally').toBeLessThanOrEqual(clientWidth);
}
/** Controls in the page content (and an open dialog) must be at least 44 px tall. Checkboxes are covered by their 44 px label rows. */
async function contentTargets(page: Page) {
  const small = await page.evaluate(() => [...document.querySelectorAll(
    '#main-content :is(button, select, a[href], input:not([type=checkbox]):not([type=radio]):not([type=hidden])), dialog[open] :is(button, select, a[href], input:not([type=checkbox]):not([type=radio]))')]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height < 44; })
    .map((element) => (element.getAttribute('aria-label') || element.textContent || element.getAttribute('name') || element.tagName).trim().slice(0, 60)));
  expect(small, 'content touch targets under 44 px').toEqual([]);
}
async function axe(page: Page, info: TestInfo, name: string) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  await info.attach(name + '-accessibility', { body: JSON.stringify(result.violations, null, 2), contentType: 'application/json' });
  expect(result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);
}
async function check(page: Page, info: TestInfo, name: string) {
  await expect(page.locator('[role=status]').filter({ hasText: /Loading/ })).toHaveCount(0);
  await info.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  await noHorizontalScroll(page);
  await contentTargets(page);
  await axe(page, info, name);
}
async function open(browser: import('@playwright/test').Browser, install: Install, role: 'owner' | 'coach', options: { viewport: { width: number; height: number }; hasTouch: boolean }): Promise<[BrowserContext, Page]> {
  const context = await browser.newContext({ ...options, timezoneId: browserZone, ignoreHTTPSErrors: true });
  await install.clients[role].browser(context);
  return [context, await context.newPage()];
}
/** Navigates through the admin menu like a user (no full page load, so assets and bootstrap aren't refetched). */
async function go(page: Page, href: string) {
  const link = page.locator(`#admin-navigation a[href="${href}"]`);
  await link.waitFor({ state: 'attached' });
  if (!await link.isVisible()) await page.getByRole('button', { name: 'Menu' }).click();
  await link.click();
  await expect(page).toHaveURL(gymOrigin + href);
}
/** A session in the calendar (its time range first), not the weekly class's edit and delete buttons. */
function sessionButton(page: Page, size: string) {
  return page.getByRole('button', { name: new RegExp(`^\\d{2}:\\d{2}–\\d{2}:\\d{2} QA ${size} class`) });
}
/** A phone dialog fills the screen; on desktop it is a centered panel. */
async function dialogLayout(page: Page, name: string, phone: boolean) {
  const box = (await page.getByRole('dialog', { name }).boundingBox())!;
  const viewport = page.viewportSize()!;
  if (phone) { expect(box.width).toBeGreaterThanOrEqual(viewport.width - 1); expect(box.height).toBeGreaterThanOrEqual(viewport.height - 1); }
  else expect(box.width).toBeLessThan(viewport.width - 100);
}

// Every request from the browser and the API helper shares one client address, so each test (about 140 requests)
// starts in a fresh window of the app's 300-per-minute flood limit, and leaves the next spec a fresh one.
const rateWindow = () => new Promise((resolve) => setTimeout(resolve, 61_000));
test.beforeEach(async () => { test.setTimeout(330_000); await rateWindow(); });
test.afterAll(async () => { await rateWindow(); });

for (const { name: size, viewport, hasTouch } of viewports) {
  const phone = size === 'phone', last = phone ? 'Phone' : 'Desktop';
  test(`admin screens at ${size} width: find a member, move a session, check in, promote, dashboard`, async ({ browser, install }, info) => {
    const owner = install.clients.owner;
    const settings = (await owner.json<{ data: RecordId & { timezone: string } }>('/api/settings')).data;
    const zone = phone ? 'America/New_York' : 'Asia/Tokyo';
    await owner.json('/api/settings', 'PATCH', { revision: settings.revision, timezone: zone });
    try {
      const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: `Mobile ${last} family` })).data;
      const member = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id, firstName: 'Casey', lastName: last, status: 'active' })).data;
      const today = new Date(), classDay = (weekday(localDate(today, zone)) + 2) % 7;
      const template = (await owner.json<{ data: RecordId }>('/api/schedule/templates', 'POST', { name: `QA ${size} class`, weekday: classDay, localStartTime: '18:00',
        durationMinutes: 60, coachId: null, capacity: null, notes: null, kind: 'class', programIds: [install.program.id], tagIds: [] })).data;
      const until = new Date(Date.now() + 21 * 86_400_000).toISOString();
      const generated = (await owner.json<{ data: Session[] }>(`/api/schedule/sessions?from=${today.toISOString()}&until=${until}&limit=100`)).data
        .filter((session) => session.templateId === template.id).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
      expect(generated.length).toBeGreaterThanOrEqual(2);
      const [first, second] = generated as [Session, Session];

      const [context, page] = await open(browser, install, 'owner', { viewport, hasTouch });
      let requests = 0;
      context.on('request', () => { requests++; });
      try {
        // Each of these admin screens: no sideways scroll, 44 px targets, axe WCAG 2.1 A/AA on the whole page.
        await page.goto(gymOrigin + '/admin');
        for (const href of screens) {
          await go(page, href);
          await expect(page.locator('#main-content h1')).toBeVisible();
          await expect(page.locator('#main-content [role=status]').filter({ hasText: /Loading/ })).toHaveCount(0);
          await check(page, info, `${size}${href.replaceAll('/', '-')}`);
        }

        // A reload failure remains visible even after settings were loaded successfully.
        await page.route(gymOrigin + '/api/settings', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
        await page.getByRole('button', { name: 'Reload settings', exact: true }).click();
        const loadError = page.getByRole('alert').filter({ hasText: 'Unable to save or load settings.' });
        await expect(loadError).toBeVisible();
        await loadError.getByRole('button', { name: 'Try again', exact: true }).click();
        await expect(loadError).toBeHidden();

        // Dashboard: widgets stack in one column on phones.
        await go(page, '/admin');
        await expect(page.getByRole('heading', { name: 'Active members', exact: true })).toBeVisible();
        const cards = await page.locator('#main-content section[aria-labelledby^="dashboard-"]').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().left));
        expect(cards.length).toBeGreaterThan(1);
        if (phone) expect(new Set(cards.map(Math.round)).size).toBe(1);
        else expect(new Set(cards.map(Math.round)).size).toBeGreaterThan(1);

        // Find a member by name and open the profile.
        await go(page, '/admin/members');
        await page.getByLabel('Search members', { exact: true }).fill(last);
        await page.getByRole('link', { name: new RegExp(`Casey ${last}`) }).click();
        await expect(page.getByRole('heading', { level: 1, name: `Casey ${last}` })).toBeVisible();
        await check(page, info, `${size}-member-profile`);

        // Promotion from the profile's ranks tab.
        await page.getByRole('tab', { name: 'Ranks & promotions', exact: true }).click();
        const panel = page.getByRole('tabpanel', { name: 'Ranks & promotions', exact: true });
        await panel.getByLabel('Program').selectOption(install.program.id);
        await panel.getByLabel('Target rank').selectOption(install.ranks[0]!.id);
        const promotedAt = new Date();
        const browserTime = new Intl.DateTimeFormat('en-GB', { timeZone: browserZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(promotedAt);
        await panel.getByLabel('Promotion date and time', { exact: true }).fill(localDate(promotedAt, browserZone) + 'T' + browserTime);
        await panel.getByRole('button', { name: 'Record promotion', exact: true }).click();
        await expect(panel.getByText('Saved.', { exact: true })).toBeVisible();
        await expect(panel.getByRole('listitem').filter({ hasText: install.ranks[0]!.name })).toHaveCount(1);
        await check(page, info, `${size}-promotion`);

        // Schedule: the agenda on phones and the week grid on desktop, then move one generated session.
        await go(page, '/admin/schedule');
        await page.getByLabel('Week of', { exact: true }).fill(localDate(new Date(first.startsAt), zone));
        await expect(page.getByRole('list', { name: 'Sessions this week, by day' })).toHaveCount(phone ? 1 : 0);
        await sessionButton(page, size).click();
        const dialog = page.getByRole('dialog', { name: `QA ${size} class` });
        await expect(dialog).toBeVisible();
        await dialogLayout(page, `QA ${size} class`, phone);
        await check(page, info, `${size}-session`);
        await dialog.getByRole('button', { name: 'Edit or move session', exact: true }).click();
        await expect(dialog.getByLabel('Start time', { exact: true })).toHaveValue('18:00');
        if (phone) {
          // A real browser rejects the New York spring gap even when its own timezone is Honolulu.
          await dialog.getByLabel('Date', { exact: true }).fill('2026-03-08');
          await dialog.getByLabel('Start time', { exact: true }).fill('02:30');
          await dialog.getByRole('button', { name: 'Save session', exact: true }).click();
          await expect(dialog.getByRole('alert')).toContainText('clocks change');
          await dialog.getByLabel('Start time', { exact: true }).fill('18:00');
        }
        // Onto the exact start of the next occurrence of the same weekly class: refused with a clear message.
        await dialog.getByLabel('Date', { exact: true }).fill(localDate(new Date(second.startsAt), zone));
        await dialog.getByRole('button', { name: 'Save session', exact: true }).click();
        await expect(dialog.getByRole('alert')).toContainText('already starts at exactly this time');
        await check(page, info, `${size}-session-move`);
        await dialog.getByLabel('Date', { exact: true }).fill(localDate(new Date(first.startsAt), zone));
        await dialog.getByLabel('Start time', { exact: true }).fill('19:30');
        await dialog.getByRole('button', { name: 'Save session', exact: true }).click();
        await expect(dialog.getByText(/^Session moved\./)).toBeVisible();
        const moved = (await owner.json<{ data: Session }>('/api/schedule/sessions/' + first.id)).data;
        expect(moved).toMatchObject({ id: first.id, revision: first.revision + 1 });
        expect(wall(new Date(moved.startsAt), zone)).toEqual({ date: localDate(new Date(first.startsAt), zone), time: '19:30' });
        expect(Date.parse(moved.startsAt) % 60_000).toBe(0);
        expect(Date.parse(moved.endsAt) - Date.parse(moved.startsAt)).toBe(60 * 60_000);
        await expect(dialog.getByText('19:30–20:30 · ' + zone, { exact: true })).toBeVisible();
        expect((await owner.json<{ data: Session }>('/api/schedule/sessions/' + second.id)).data.startsAt).toBe(second.startsAt);
        await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await expect(dialog).toBeHidden();
      } finally { info.annotations.push({ type: 'owner requests', description: String(requests) }); await context.close(); }

      // A coach checks the member in from the session's roster.
      const [coachContext, coachPage] = await open(browser, install, 'coach', { viewport, hasTouch });
      try {
        await coachPage.goto(gymOrigin + '/admin/schedule');
        await coachPage.getByLabel('Week of', { exact: true }).fill(localDate(new Date(first.startsAt), zone));
        await sessionButton(coachPage, size).click();
        const roster = coachPage.getByRole('region', { name: 'Coach check-in roster', exact: true });
        await roster.getByLabel('Member name', { exact: true }).fill(last);
        await roster.getByRole('button', { name: 'Search members', exact: true }).click();
        await roster.getByRole('button', { name: `Check in Casey ${last}`, exact: true }).click();
        await expect(roster.getByRole('button', { name: `Casey ${last} is checked in`, exact: true })).toBeDisabled();
        await check(coachPage, info, `${size}-coach-roster`);
        await coachPage.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await coachPage.goto(gymOrigin + '/admin/settings');
        await expect(coachPage.getByText('No settings available for your role', { exact: true })).toBeVisible();
        await check(coachPage, info, `${size}-coach-settings`);
      } finally { await coachContext.close(); }
      const attendance = await install.clients.coach.json<{ data: { memberId: string }[] }>('/api/attendance?sessionId=' + first.id);
      expect(attendance.data.map((entry) => entry.memberId)).toContain(member.id);
    } finally {
      const current = (await owner.json<{ data: RecordId }>('/api/settings')).data;
      await owner.json('/api/settings', 'PATCH', { revision: current.revision, timezone: settings.timezone });
    }
  });
}
