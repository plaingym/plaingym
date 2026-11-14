// SPDX-License-Identifier: AGPL-3.0-only
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { expect, gymOrigin, localDate, showWeek, test, wall, weekday, createClass, demoClient, type Install, type Person, type RecordId } from '../support.js';
import { accessibleThemes, keyboardActivate, tabTo } from '../responsive.js';
import { stripeOrigin, outboxIds, outboxLink } from '../portal.js';

// Device and signed-link tokens are bearer credentials: never record browser traces.
test.use({ trace: 'off', screenshot: 'off' });

const screens = ['/admin', '/admin/members', '/admin/schedule', '/admin/ranks', '/admin/staff', '/admin/imports', '/admin/settings'];
const browserZone = 'Pacific/Honolulu';
const viewports = [
  { name: 'phone', viewport: { width: 360, height: 740 }, hasTouch: true },
  { name: 'desktop', viewport: { width: 1280, height: 800 }, hasTouch: false },
] as const;
interface Session extends RecordId { templateId: string | null; startsAt: string; endsAt: string }

/** Controls in the page content (and an open dialog) must be at least 44 px tall, and buttons and selects 44 px wide.
 * Checkboxes are covered by their 44 px label rows; inline links may be narrower. */
async function contentTargets(page: Page) {
  const small = await page.evaluate(() => [...document.querySelectorAll(
    '#main-content :is(button, select, a[href], input:not([type=checkbox]):not([type=radio]):not([type=hidden])), dialog[open] :is(button, select, a[href], input:not([type=checkbox]):not([type=radio]))')]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && (box.height < 44 || (element.matches('button, select') && box.width < 44)); })
    .map((element) => (element.getAttribute('aria-label') || element.textContent || element.getAttribute('name') || element.tagName).trim().slice(0, 60)));
  expect(small, 'content touch targets under 44 px').toEqual([]);
}
async function check(page: Page, info: TestInfo, name: string) {
  await expect(page.locator('[role=status]').filter({ hasText: /Loading/ })).toHaveCount(0);
  await contentTargets(page);
  // Checks page width, touch targets, language and axe, and attaches a screenshot, per color preference.
  await accessibleThemes(page, info, name);
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

test.beforeEach(() => { test.setTimeout(270_000); });

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
        // The field takes the browser's wall clock, one reading of the instant for both its date and its time.
        const promotedAt = wall(new Date(), browserZone);
        await panel.getByLabel('Promotion date and time', { exact: true }).fill(promotedAt.date + 'T' + promotedAt.time);
        await panel.getByRole('button', { name: 'Record promotion', exact: true }).click();
        await expect(panel.getByText('Saved.', { exact: true })).toBeVisible();
        await expect(panel.getByRole('listitem').filter({ hasText: install.ranks[0]!.name })).toHaveCount(1);
        await check(page, info, `${size}-promotion`);

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
        await expect(dialog.getByText('19:30–20:30 · ' + zone, { exact: true })).toBeVisible();
        expect((await owner.json<{ data: Session }>('/api/schedule/sessions/' + second.id)).data.startsAt).toBe(second.startsAt);
        await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await expect(dialog).toBeHidden();
      } finally { info.annotations.push({ type: 'owner requests', description: String(requests) }); await context.close(); }

      // A coach checks the member in from the session's roster.
      const [coachContext, coachPage] = await open(browser, install, 'coach', { viewport, hasTouch });
      try {
        await coachPage.goto(gymOrigin + '/admin/schedule');
        await showWeek(coachPage, zone, Date.parse(first.startsAt));
        await sessionButton(coachPage, size).click();
        const roster = coachPage.getByRole('region', { name: 'Coach check-in roster', exact: true });
        await roster.getByLabel('Member name', { exact: true }).fill(last);
        await roster.getByRole('button', { name: 'Search members', exact: true }).click();
        await roster.getByRole('button', { name: `Check in Casey ${last}`, exact: true }).click();
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
  });
}

test.describe('member and public accessibility', () => {
  for (const { name: size, viewport } of viewports) {
    test(`every portal page at ${size} width in light and dark`, async ({ page, context, sandboxes }, info) => {
      const sandbox = sandboxes[0]!, student = await demoClient(sandbox, 'student');
      await student.browser(context);
      await page.setViewportSize(viewport);
      for (const part of ['', '/schedule', '/checkin', '/progress', '/billing', '/waivers', '/household', '/account']) {
        await page.goto(sandbox.origin + '/portal' + part);
        await expect(page.locator('main h1')).toBeVisible();
        await expect(page.getByRole('status').filter({ hasText: /^Loading/ })).toHaveCount(0);
        await accessibleThemes(page, info, `${size}-portal${part.replace('/', '-') || '-home'}`);
      }
    });

    test(`signed links and core public pages at ${size} width in light and dark`, async ({ page, sandboxes }, info) => {
      const sandbox = sandboxes[0]!, owner = await demoClient(sandbox, 'owner');
      const household = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: 'Accessibility ' + size })).data;
      const member = (await owner.json<{ data: RecordId }>('/api/members', 'POST', { householdId: household.id,
        firstName: 'Accessibility', lastName: size, dateOfBirth: '1990-01-01' })).data;
      const invoice = (await owner.json<{ data: RecordId }>('/api/billing/invoices/one-off', 'POST', { householdId: household.id,
        dueOn: localDate(new Date(), 'UTC'), source: 'custom', description: 'Accessibility review', currency: 'USD', amountCents: 1000, taxRateIds: [] })).data;
      await page.setViewportSize(viewport);
      for (const [purpose, extra] of [['pay_invoice', { invoiceId: invoice.id }], ['update_card', {}], ['onboarding', {}], ['sign_waiver', { memberId: member.id }]] as const) {
        const link = (await owner.json<{ data: { link: RecordId; token: string } }>('/api/links', 'POST', {
          purpose, householdId: household.id, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ...extra,
        })).data;
        await page.goto(sandbox.origin + '/l/' + link.token);
        await expect(page.locator('main h1')).toBeVisible();
        await accessibleThemes(page, info, `${size}-link-${purpose}`);
        await owner.json('/api/links/' + link.link.id + '/revoke', 'POST', {});
      }
      await page.reload();
      await expect(page.getByRole('heading', { name: 'This link is unavailable', exact: true })).toBeVisible();
      await accessibleThemes(page, info, size + '-link-unavailable');
      for (const path of ['/join', '/trial', '/drop-in']) {
        await page.goto(sandbox.origin + path);
        await expect(page.locator('main h1')).toBeVisible();
        await accessibleThemes(page, info, size + path.replace('/', '-'));
        if (path === '/join') {
          await page.locator('a[href^="/join?plan="]').first().click();
          await expect(page.locator('form[data-join-form]')).toBeVisible();
          await accessibleThemes(page, info, size + '-join-form');
        }
      }
      // Unsubscribe links are issued only by an announcement, never by the staff link endpoint.
      const initial = (await owner.json<{ data: RecordId & { memberEmailsEnabled: boolean } }>('/api/settings/go-live')).data;
      try {
        if (!initial.memberEmailsEnabled) await owner.json('/api/settings/go-live', 'PATCH', { revision: initial.revision, memberEmailsEnabled: true });
        const people = (await owner.json<{ data: (RecordId & { status: string; email: string | null })[] }>('/api/members?limit=100')).data;
        const recipient = people.find(person => person.status === 'active' && person.email)!;
        const before = await outboxIds(owner);
        await owner.json('/api/announcements/send', 'POST', { subject: 'Accessibility review ' + size, body: 'Class notice.', sendGeneration: crypto.randomUUID(), confirm: true });
        const unsubscribe = await outboxLink(owner, recipient.email!, /^\/l\//, before);
        await page.goto(unsubscribe.href);
        await expect(page.getByRole('button', { name: 'Unsubscribe', exact: true })).toBeVisible();
        await accessibleThemes(page, info, size + '-link-unsubscribe');
      } finally {
        if (!initial.memberEmailsEnabled) {
          const current = (await owner.json<{ data: RecordId }>('/api/settings/go-live')).data;
          await owner.json('/api/settings/go-live', 'PATCH', { revision: current.revision, memberEmailsEnabled: false });
        }
      }
    });

    test(`kiosk check-in by keyboard alone at ${size} width`, async ({ page, sandboxes }, info) => {
      const sandbox = sandboxes[0]!;
      const owner = await demoClient(sandbox, 'owner');
      const memberRow = (await owner.json<{ data: Person[] }>('/api/members?search=Marcus')).data.find(person => person.firstName === 'Marcus' && person.lastName === 'Rivera')!;
      const current = (await owner.json<{ data: RecordId }>('/api/households/' + memberRow.householdId)).data;
      // The isolation sweep deliberately changes this household's PIN. Own this flow's credentials.
      await owner.json('/api/households/' + memberRow.householdId + '/pin', 'PUT', { revision: current.revision, pin: '2468' });
      await page.setViewportSize(viewport);
      await page.goto(sandbox.origin + '/kiosk');
      const skip = page.getByRole('link', { name: 'Skip to content', exact: true });
      await tabTo(page, skip);
      const skipBox = (await skip.boundingBox())!;
      expect(skipBox.height).toBeGreaterThanOrEqual(44);
      expect(skipBox.width).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Enter');
      await tabTo(page, page.getByLabel('Device token', { exact: true }));
      await page.keyboard.insertText(sandbox.kioskToken);
      await keyboardActivate(page, page.getByRole('button', { name: 'Save and start check-in', exact: true }));
      await expect(page.getByRole('heading', { name: 'How would you like to check in?', exact: true })).toBeFocused();
      await accessibleThemes(page, info, size + '-keyboard-kiosk-choice');
      await keyboardActivate(page, page.getByRole('button', { name: 'Scan a QR code', exact: true }));
      await expect(page.locator('[data-kiosk-focus]')).toBeFocused();
      await accessibleThemes(page, info, size + '-keyboard-kiosk-camera');
      await keyboardActivate(page, page.getByRole('button', { name: 'Start over', exact: true }));
      await keyboardActivate(page, page.getByRole('button', { name: 'Name and PIN', exact: true }));
      await expect(page.getByLabel('Your name', { exact: true })).toBeFocused();
      await page.keyboard.insertText('Marcus Rivera');
      await tabTo(page, page.getByLabel('Household PIN', { exact: true }));
      await page.keyboard.insertText('2468');
      await accessibleThemes(page, info, size + '-keyboard-kiosk-search');
      await keyboardActivate(page, page.getByRole('button', { name: 'Find me', exact: true }));
      await expect(page.locator('#kiosk-select')).toBeFocused();
      const member = page.getByRole('checkbox', { name: /Marcus/ });
      await tabTo(page, member);
      await page.keyboard.press('Space');
      await expect(member).toHaveAttribute('aria-checked', 'false');
      await page.keyboard.press('Space');
      await expect(member).toHaveAttribute('aria-checked', 'true');
      await accessibleThemes(page, info, size + '-keyboard-kiosk-members');
      await keyboardActivate(page, page.getByRole('button', { name: 'Check in', exact: true }));
      await expect(page.getByRole('heading', { name: 'Check-in results', exact: true })).toBeFocused();
      // A first visit offers open mat; a later viewport can already be checked in.
      const openMat = page.getByRole('button', { name: 'Open mat', exact: true });
      const choices = await openMat.count();
      for (let i = 0; i < choices; i++) await keyboardActivate(page, openMat.first());
      await expect(openMat).toHaveCount(0);
      await expect(page.getByText(/^(Checked in|Already checked in)$/).first()).toBeVisible();
      await accessibleThemes(page, info, size + '-keyboard-kiosk-results');
      await keyboardActivate(page, page.getByRole('button', { name: 'Done', exact: true }));
      await expect(page.locator('#kiosk-choose')).toBeFocused();
    });

    test(`portal booking, payment and dialog focus by keyboard alone at ${size} width`, async ({ page, context, sandboxes }, info) => {
      const sandbox = sandboxes[0]!, owner = await demoClient(sandbox, 'owner'), student = await demoClient(sandbox, 'student');
      const session = await createClass(owner, 'Keyboard class ' + size);
      const household = (await student.json<{ data: RecordId }>('/api/portal/household')).data;
      const invoice = (await owner.json<{ data: RecordId & { number: string } }>('/api/billing/invoices/one-off', 'POST', { householdId: household.id,
        dueOn: localDate(new Date(), 'UTC'), source: 'custom', description: 'Keyboard payment', currency: 'USD', amountCents: 1000, taxRateIds: [] })).data;
      await student.browser(context);
      await page.setViewportSize(viewport);
      await page.goto(sandbox.origin + '/portal/schedule');
      await keyboardActivate(page, page.getByRole('button', { name: new RegExp('^Book ' + session.name + ' for ') }));
      const cancel = page.getByRole('button', { name: new RegExp('^Cancel booking: ' + session.name + ' for ') });
      await expect(cancel).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: /is booked/ })).toBeVisible();
      await keyboardActivate(page, cancel);
      await expect(page.getByRole('status').filter({ hasText: /is cancelled/ })).toBeVisible();
      await accessibleThemes(page, info, size + '-keyboard-booking');

      await page.goto(sandbox.origin + '/portal/household');
      const edit = page.getByRole('button', { name: 'Edit details', exact: true }).first();
      await keyboardActivate(page, edit);
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press(i < 20 ? 'Tab' : 'Shift+Tab');
        expect(await dialog.evaluate(element => element.contains(document.activeElement)), 'dialog contains keyboard focus').toBe(true);
      }
      await accessibleThemes(page, info, size + '-keyboard-profile-dialog');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(edit).toBeFocused();

      await page.goto(sandbox.origin + '/portal/billing');
      const bill = page.getByRole('listitem').filter({ hasText: 'Invoice #' + invoice.number });
      await keyboardActivate(page, bill.getByRole('button', { name: 'Pay now', exact: true }));
      await page.waitForURL(url => url.origin === stripeOrigin);
      await tabTo(page, page.getByLabel('Card number', { exact: true }));
      await page.keyboard.insertText('4242 4242 4242 4242');
      await keyboardActivate(page, page.getByRole('button', { name: 'Pay', exact: true }));
      await page.waitForURL(url => url.origin === sandbox.origin && url.pathname.startsWith('/l/'));
      await expect(page.locator('main h1')).toBeVisible();
      await accessibleThemes(page, info, size + '-keyboard-payment-return');
      await page.goto(sandbox.origin + '/portal/billing');
      await keyboardActivate(page, page.getByRole('button', { name: /^(Add a card|Update card)$/ }));
      await page.waitForURL(url => url.origin === stripeOrigin);
    });
  }
});
