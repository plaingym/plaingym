// SPDX-License-Identifier: AGPL-3.0-only
import type { Browser, TestInfo } from '@playwright/test';
import { expect, gymOrigin, localDate, showWeek, wall, weekday, type Install, type Person, type RecordId } from '../support.js';
import { browserZone, check, open, go, sessionButton, dialogLayout, viewports } from './mobile-screens.js';

interface Session extends RecordId { templateId: string | null; startsAt: string; endsAt: string }
const screens = [
  '/admin', '/admin/members', '/admin/schedule', '/admin/ranks', '/admin/staff', '/admin/imports',
  '/admin/leads', '/admin/billing/plans', '/admin/billing/invoices', '/admin/waivers',
  '/admin/announcements', '/admin/campaigns', '/admin/reports', '/admin/health', '/admin/settings',
];

export async function adminScreens(browser: Browser, install: Install, info: TestInfo, options: (typeof viewports)[number]) {
  const { name: size, viewport, hasTouch } = options;
  const phone = size === 'phone', last = phone ? 'Phone' : 'Desktop';
  const owner = install.clients.owner;
  const settings = (await owner.json<{ data: RecordId & { timezone: string; currency: string } }>('/api/settings')).data;
  const zone = phone ? 'America/New_York' : 'Asia/Tokyo';
  await owner.json('/api/settings', 'PATCH', { revision: settings.revision, timezone: zone });
  try {
    const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: `Mobile ${last} family` })).data;
    const member = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id, firstName: 'Casey', lastName: last, status: 'active' })).data;
    const lead = (await owner.json<{ data: Person }>('/api/members', 'POST', {
      householdId: home.id, firstName: 'Prospect', lastName: last, status: 'prospect',
    })).data;
    const invoice = (await owner.json<{ data: { id: string; number: number } }>('/api/billing/invoices/one-off', 'POST', {
      householdId: home.id, dueOn: localDate(new Date(), zone), source: 'custom', description: 'Class equipment',
      currency: settings.currency, amountCents: 1500, taxRateIds: [],
    })).data;
    // An exhausted pack holder may still be checked in by staff, with an explicit notice.
    for (const credits of [1, -1]) await owner.json('/api/billing/credits/adjust', 'POST', {
      memberId: member.id, credits, reason: 'Opening credit correction', adjustmentId: crypto.randomUUID(),
    });
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
    // Created last, so the try below always retires it.
    const waiverName = `Mobile ${last} participation waiver`;
    const waiver = (await owner.json<{ data: { id: string; version: number } }>('/api/waivers/templates', 'POST', {
      name: waiverName, kind: 'waiver', body: 'Please tell an instructor about any injuries before training.',
    })).data;
    try {
      // Each of these admin screens: no sideways scroll, 44 px targets, axe WCAG 2.1 A/AA on the whole page.
      await page.goto(gymOrigin + '/admin');
      for (const href of screens) {
        await go(page, href);
        await expect(page.locator('#main-content h1')).toBeVisible();
        if (href === '/admin/leads') await expect(page.getByRole('link', { name: `Prospect ${last}`, exact: true })).toBeVisible();
        if (href === '/admin/waivers') await expect(page.getByRole('heading', { name: waiverName, exact: true })).toBeVisible();
        if (href === '/admin/health') await expect(page.getByRole('heading', { name: 'Disk space', exact: true })).toBeVisible();
        if (href === '/admin/settings') await expect(page.getByText('QA tablet', { exact: true })).toBeVisible();
        await check(page, info, `${size}${href.replaceAll('/', '-')}`);
      }

      // A reload failure remains visible even after settings were loaded successfully.
      await page.route(gymOrigin + '/api/settings', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
      await page.getByRole('button', { name: 'Reload settings', exact: true }).click();
      const loadError = page.getByRole('alert').filter({ hasText: 'Unable to save or load settings.' });
      await expect(loadError).toBeVisible();
      await loadError.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(loadError).toBeHidden();

      await page.getByRole('button', { name: 'Connect SMS provider', exact: true }).click();
      const smsTest = page.getByRole('form', { name: 'SMS provider settings', exact: true });
      await smsTest.getByLabel('Send the test text to').fill('+12025550123');
      await check(page, info, `${size}-settings-sms-test`);

      await go(page, '/admin/billing/invoices');
      await page.getByRole('button', { name: 'View invoice ' + invoice.number, exact: true }).click();
      const invoiceDialog = page.getByRole('dialog');
      await expect(invoiceDialog.getByText('Class equipment', { exact: true })).toBeVisible();
      await check(page, info, `${size}-invoice-dialog`);
      await page.goto(gymOrigin + '/admin/billing/invoices/' + invoice.id);
      await expect(page.getByText('Class equipment', { exact: true })).toBeVisible();
      await check(page, info, `${size}-invoice-detail`);

      await page.goto(gymOrigin + '/admin/leads/' + lead.id);
      await expect(page.getByRole('heading', { level: 1, name: `Prospect ${last}` })).toBeVisible();
      await check(page, info, `${size}-lead-detail`);

      await page.goto(gymOrigin + '/admin/account');
      await expect(page.locator('#main-content h1')).toBeVisible();
      await check(page, info, `${size}-admin-account`);

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
      await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toHaveAccessibleDescription(/Membership changes reset this status/);
      await check(page, info, `${size}-member-profile`);

      // Promotion from the profile's ranks tab.
      await page.getByRole('tab', { name: 'Ranks & promotions', exact: true }).click();
      const panel = page.getByRole('tabpanel', { name: 'Ranks & promotions', exact: true });
      await panel.getByLabel('Program').selectOption(install.program.id);
      await panel.getByLabel('Target rank').selectOption(install.ranks[0]!.id);
      // The field takes the browser's wall clock, one reading of the instant for both its date and its time.
      const promotedAt = wall(new Date(), browserZone);
      await panel.getByLabel('Promotion date and time', { exact: true }).fill(promotedAt.date + 'T' + promotedAt.time);
      await panel.getByRole('button', { name: 'Record promotion', exact: true }).click();
      await expect(panel.getByText('Saved.', { exact: true })).toBeVisible();
      await expect(panel.getByRole('listitem').filter({ hasText: install.ranks[0]!.name })).toHaveCount(1);
      await check(page, info, `${size}-promotion`);

      await page.goto(`${gymOrigin}/admin/members/${member.id}#memberTabs.waivers`);
      await page.locator('li').filter({ hasText: waiverName }).getByRole('button', { name: 'Review and sign', exact: true }).click();
      const signing = page.getByRole('dialog');
      await expect(signing.locator('canvas')).toBeVisible();
      await check(page, info, `${size}-staff-waiver-signing`);
      await signing.getByRole('button', { name: 'Close', exact: true }).first().click();
      await expect(signing).toBeHidden();

      // Schedule: the agenda on phones and the week grid on desktop, then move one generated session.
      await go(page, '/admin/schedule');
      await showWeek(page, zone, Date.parse(first.startsAt));
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
      await expect(dialog.getByText('7:30 PM–8:30 PM · ' + zone, { exact: true })).toBeVisible();
      expect((await owner.json<{ data: Session }>('/api/schedule/sessions/' + second.id)).data.startsAt).toBe(second.startsAt);
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await expect(dialog).toBeHidden();
    } finally {
      info.annotations.push({ type: 'owner requests', description: String(requests) });
      await context.close();
      await owner.json(`/api/waivers/templates/${waiver.id}/retire`, 'POST', { expectedVersion: waiver.version });
    }

    // A coach checks the member in from the session's roster.
    const [coachContext, coachPage] = await open(browser, install, 'coach', { viewport, hasTouch });
    try {
      await coachPage.goto(gymOrigin + '/admin/schedule');
      await showWeek(coachPage, zone, Date.parse(first.startsAt));
      await sessionButton(coachPage, size).click();
      const roster = coachPage.getByRole('region', { name: 'Coach check-in roster', exact: true });
      await roster.getByRole('combobox', { name: 'Check in someone else', exact: true }).fill(last);
      await roster.getByRole('option', { name: `Casey ${last}`, exact: true }).click();
      await expect(roster.getByRole('button', { name: `Casey ${last} is checked in`, exact: true })).toBeDisabled();
      await expect(roster.getByText('Checked in without spending a credit. This member needs more credits.')).toBeVisible();
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
}
