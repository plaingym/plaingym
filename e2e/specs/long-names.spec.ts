// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { test, expect, createClass, demoClient, Client, gymTimezone, showWeek, showPortalClass, type Person, type Program, type RecordId, type Sandbox } from '../support.js';
import { accessibleLayout, horizontalOverflow } from '../responsive.js';
import { claimPortal, outboxIds, outboxLink } from '../portal.js';

// Cookies and links are bearer credentials. Keep them out of traces and screenshots.
test.use({ trace: 'off', screenshot: 'off', viewport: { width: 360, height: 740 } });

/** A 56-character name with no break opportunity: user-supplied text can be this long, and the page must wrap it. */
const unbreakable = (prefix: string) => (prefix + randomBytes(2).toString('hex')).padEnd(56, 'x');

async function noSideways(page: Page, surface: string) {
  expect(await horizontalOverflow(page), surface + ': horizontal scroll at 360 px').toBeUndefined();
  for (const control of await page.locator('[data-name-wrap]:visible').all()) {
    await expect(control).toHaveCSS('overflow-wrap', 'anywhere');
    expect(await control.evaluate(element => element.scrollWidth <= element.clientWidth + 1), surface + ': name control overflows').toBe(true);
  }
}
async function phoneAndDesktop(page: Page, info: import('@playwright/test').TestInfo, surface: string) {
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await noSideways(page, surface);
    await accessibleLayout(page, info, surface + ' at ' + width + ' px');
  }
  await page.setViewportSize({ width: 360, height: 740 });
}
for (const flow of ['PIN', 'QR'] as const) {
  test('kiosk ' + flow + ' wraps member names and named class buttons', async ({ page, sandboxes }, info) => {
    const sandbox = sandboxes[1]!, firstName = unbreakable('Kioskmember'), name = unbreakable('Kioskclass');
    const member = { id: '01900000-0000-7000-8000-000000000011', firstName, lastInitial: 'W', photoUrl: null };
    const result = { status: 'select_session', member, sessions: [{
      id: '01900000-0000-7000-8000-000000000012', name, startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 3600_000).toISOString(),
    }] };
    await page.route('**/api/kiosk/lookup', route => route.fulfill({ json: { data: { status: 'select_member', members: [member] } } }));
    await page.route('**/api/kiosk/checkin', route => route.fulfill({ json: { data: [result] } }));
    await page.route('**/api/kiosk/checkin/qr', route => route.fulfill({ json: { data: result } }));
    if (flow === 'QR') await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
        getUserMedia: async () => new MediaStream(), enumerateDevices: async () => [{ kind: 'videoinput' }],
      } });
      Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: async () => undefined });
      for (const [property, value] of [['readyState', 4], ['videoWidth', 640], ['videoHeight', 480]] as const)
        Object.defineProperty(HTMLVideoElement.prototype, property, { configurable: true, get: () => value });
      Object.defineProperty(globalThis, 'BarcodeDetector', { configurable: true, value: class {
        async detect() { return [{ rawValue: 'pgci1_' + 'x'.repeat(43) }]; }
      } });
    });
    await page.goto(sandbox.origin + '/kiosk');
    const pin = page.getByRole('button', { name: 'Name and PIN', exact: true }), token = page.getByLabel('Device token', { exact: true });
    await expect(pin.or(token)).toBeVisible();
    if (await token.isVisible()) {
      await token.fill(sandbox.kioskToken);
      await page.getByRole('button', { name: 'Save and start check-in', exact: true }).click();
    }
    if (flow === 'PIN') {
      await pin.click();
      await page.getByLabel('Your name', { exact: true }).fill('Kiosk');
      await page.getByLabel('Household PIN', { exact: true }).fill('2468');
      await page.getByRole('button', { name: 'Find me', exact: true }).click();
      const choice = page.getByRole('checkbox', { name: new RegExp(firstName) });
      await expect(choice).toHaveAttribute('data-name-wrap', '');
      await phoneAndDesktop(page, info, 'kiosk member selection');
      await expect(choice).toHaveAttribute('aria-checked', 'true');
      await page.getByRole('button', { name: 'Check in', exact: true }).click();
    } else await page.getByRole('button', { name: 'Scan a QR code', exact: true }).click();
    const session = page.getByRole('button', { name: new RegExp(name) });
    await expect(session).toBeVisible();
    await expect(session).toHaveAttribute('data-name-wrap', '');
    await expect(page.getByText(firstName + ' W.', { exact: true })).toBeVisible();
    await phoneAndDesktop(page, info, 'kiosk ' + flow + ' class selection');
  });
}

/** Whether a label sits on one line. A word that breaks in the middle has a line box for each piece. */
async function onOneLine(label: Locator) {
  return label.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return new Set([...range.getClientRects()].map((box) => Math.round(box.top))).size === 1;
  });
}
async function admin(page: Page, sandbox: Sandbox, owner: Client, path: string) {
  await owner.browser(page.context());
  await page.goto(sandbox.origin + path);
}
const sandboxOwner = async (sandboxes: Sandbox[]) => ({ sandbox: sandboxes[1]!, owner: await demoClient(sandboxes[1]!, 'owner') });
/** Invites the household's payer and opens a portal session for them in this page. */
async function portalLogin(page: Page, sandbox: Sandbox, owner: Client, householdId: string, email: string) {
  const invitation = await owner.json<{ data: { invitationUrl: string } }>(`/api/households/${householdId}/portal-invitations`, 'POST', { email, delivery: 'print', scope: 'payer' });
  const before = await outboxIds(owner);
  await new Client(sandbox.origin).json('/api/portal/invitations/accept', 'POST', { token: new URL(invitation.data.invitationUrl).hash.slice(1) });
  const portal = await claimPortal(sandbox.origin, await outboxLink(owner, email, /^\/api\/auth\//, before));
  await portal.browser(page.context());
}

// Each probe has its own household, so no spec depends on another leaving a seeded household untouched.
test('the admin bookings panel wraps a class name with no break opportunity', async ({ page, sandboxes }) => {
  const { sandbox, owner } = await sandboxOwner(sandboxes), name = unbreakable('Class');
  const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: unbreakable('Home') })).data;
  const member = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id, firstName: 'Wrap', lastName: 'Booker', status: 'active' })).data;
  const session = await createClass(owner, name);
  await owner.json('/api/bookings', 'POST', { memberId: member.id, sessionId: session.id, allowWaitlist: false });
  await admin(page, sandbox, owner, '/admin/members/' + member.id);
  await page.getByRole('tab', { name: 'Bookings', exact: true }).click();
  await expect(page.getByText(name, { exact: false })).toBeVisible();
  await noSideways(page, 'admin bookings panel');
});

for (const kind of ['class-packs', 'discounts'] as const) {
  test('the ' + kind + ' catalog wraps its named edit button', async ({ page, sandboxes }, info) => {
    const { sandbox, owner } = await sandboxOwner(sandboxes), name = unbreakable('Catalog');
    const currency = (await owner.json<{ data: { currency: string }[] }>('/api/billing/plans?limit=1')).data[0]?.currency ?? 'USD';
    await owner.json('/api/billing/' + kind, 'POST', kind === 'class-packs'
      ? { name, currency, amountCents: 9900, credits: 10 }
      : { name, currency, percentBasisPoints: 1000, duration: 'forever' });
    await admin(page, sandbox, owner, '/admin/billing/plans');
    const edit = page.getByRole('button', { name: 'Edit ' + name, exact: true });
    await expect(edit).toBeVisible();
    await expect(edit).toHaveAttribute('data-name-wrap', '');
    await phoneAndDesktop(page, info, kind + ' catalog');
    await edit.click();
    await expect(page.getByRole('textbox', { name: kind === 'class-packs' ? 'Name' : 'Discount name', exact: true })).toHaveValue(name);
    await phoneAndDesktop(page, info, kind + ' editor');
  });
}

test('staff profile and account pickers wrap names, including inside the profile dialog', async ({ page, sandboxes }, info) => {
  const { sandbox, owner } = await sandboxOwner(sandboxes), name = unbreakable('Staff');
  const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: 'Staff wrapping' })).data;
  const member = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id,
    firstName: 'M', lastName: name, status: 'active' })).data;
  await owner.json('/api/staff/profiles', 'POST', { displayName: name, memberId: member.id });
  const accountName = unbreakable('Account');
  await page.route('**/api/staff/accounts?*', route => route.fulfill({ json: {
    data: [{ id: home.id, displayName: accountName, email: 'wrap-account@example.invalid' }], pagination: { limit: 25, offset: 0, total: 1 },
  } }));
  await admin(page, sandbox, owner, '/admin/staff');
  const account = page.getByRole('button', { name: accountName + ' wrap-account@example.invalid', exact: true });
  await expect(account).toHaveAttribute('data-name-wrap', '');
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await phoneAndDesktop(page, info, 'staff accounts and profiles');
  await account.click();
  await page.getByRole('button', { name: 'Edit ' + name, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Find a member to link (optional)').fill(name);
  const choice = dialog.getByRole('button', { name: 'M ' + name, exact: true });
  await expect(choice).toHaveAttribute('data-name-wrap', '');
  await choice.click();
  await expect(dialog.getByText('M ' + name, { exact: false }).first()).toBeVisible();
  await phoneAndDesktop(page, info, 'staff profile dialog');
});

test('admin agenda, week view and class dialog wrap class and coach names', async ({ page, sandboxes }, info) => {
  const { sandbox, owner } = await sandboxOwner(sandboxes), name = unbreakable('Session');
  const session = await createClass(owner, name);
  const coachName = unbreakable('Coach');
  const coach = (await owner.json<{ data: RecordId }>('/api/staff/profiles', 'POST', { displayName: coachName })).data;
  await owner.json('/api/schedule/sessions/' + session.id + '/coach', 'POST', { revision: session.revision, coachId: coach.id });
  await admin(page, sandbox, owner, '/admin/schedule');
  await showWeek(page, await gymTimezone(owner), new Date(session.startsAt));
  const control = page.locator('button[data-name-wrap]').filter({ hasText: name });
  await expect(control).toBeVisible();
  await expect(control.getByText(coachName, { exact: true })).toBeVisible();
  await phoneAndDesktop(page, info, 'admin schedule');
  await control.click();
  await expect(page.getByRole('dialog').getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').locator('dd').filter({ hasText: coachName })).toBeVisible();
  await phoneAndDesktop(page, info, 'class dialog');
});

test('the portal household picker marks and wraps household names', async ({ page, sandboxes }, info) => {
  const { sandbox, owner } = await sandboxOwner(sandboxes), name = unbreakable('Household');
  // The picker is otherwise difficult to seed: one login must belong to two independent households.
  await page.route('**/api/auth/bootstrap', route => route.fulfill({ json: { data: {
    gym: { id: '01900000-0000-7000-8000-000000000001', name: 'Wrapping gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
    session: { userId: '01900000-0000-7000-8000-000000000002', displayName: name, roles: [], member: true },
    login: { password: true, magicLink: false },
  } } }));
  await page.route('**/api/portal/households', route => route.fulfill({ json: { data: { current: null, households: [
    { householdId: '01900000-0000-7000-8000-000000000003', name, role: 'payer' },
    { householdId: '01900000-0000-7000-8000-000000000004', name: 'Other household', role: 'payer' },
  ] } } }));
  await admin(page, sandbox, owner, '/portal');
  const choice = page.getByRole('button', { name: new RegExp('^' + name) });
  await expect(choice).toBeVisible();
  await expect(choice).toHaveAttribute('data-name-wrap', '');
  await phoneAndDesktop(page, info, 'portal household picker');
});

test('portal home, billing, household, check-in and waivers wrap member and document names', async ({ page, sandboxes }, info) => {
  test.setTimeout(180_000);
  const { sandbox, owner } = await sandboxOwner(sandboxes), name = unbreakable('Member'), document = unbreakable('Waiver');
  const email = 'wrap-surfaces-' + randomBytes(4).toString('hex') + '@example.invalid';
  const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name, email })).data;
  const member = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id, firstName: 'M',
    lastName: name, email, dateOfBirth: '2020-01-01', status: 'active' })).data;
  const session = await createClass(owner, unbreakable('Class'));
  await owner.json('/api/bookings', 'POST', { memberId: member.id, sessionId: session.id, allowWaitlist: false });
  await owner.json('/api/waivers/templates', 'POST', { name: document, kind: 'waiver', body: unbreakable('Document') });
  await admin(page, sandbox, owner, '/admin/waivers');
  await expect(page.getByRole('heading', { name: document, exact: true })).toBeVisible();
  await phoneAndDesktop(page, info, 'admin waivers');
  await page.route('**/api/portal/credits', route => route.fulfill({ json: { householdId: home.id,
    data: [{ memberId: member.id, firstName: 'M', lastName: name, balance: 3, soonestExpiry: null }],
  } }));
  await portalLogin(page, sandbox, owner, home.id, email);
  for (const path of ['', '/billing', '/household', '/checkin', '/waivers']) {
    await page.goto(sandbox.origin + '/portal' + path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Wait for the data, not just the shell's page heading.
    if (path === '/waivers') await expect(page.getByText(document, { exact: true })).toBeVisible();
    else if (path === '') await expect(page.getByText(session.name, { exact: true })).toBeVisible();
    else if (path === '/checkin') await expect(page.getByRole('button', { name: /Create a code|Replace this code/ })).toBeVisible();
    else await expect(page.getByText('M ' + name, { exact: path === '/billing' }).last()).toBeVisible();
    await phoneAndDesktop(page, info, 'portal' + (path || '/home'));
  }
  const review = page.getByRole('listitem').filter({ hasText: document }).getByRole('button', { name: 'Review and sign', exact: true });
  await review.click();
  await expect(page.getByRole('dialog').getByText(document, { exact: false }).first()).toBeVisible();
  await phoneAndDesktop(page, info, 'portal waiver dialog');
});


test('the dashboard widgets wrap member names and shortlist links with no break opportunity', async ({ page, sandboxes }) => {
  const { sandbox, owner } = await sandboxOwner(sandboxes), first = unbreakable('First'), label = unbreakable('Household');
  // The widgets list data that depends on the clock (members unseen for 14 days), so the page gets a response with known names.
  await page.route('**/api/dashboard', async (route) => {
    await route.fulfill({ json: { data: { generatedAt: new Date().toISOString(), widgets: [
      { id: 'not_seen', titleKey: 'dashboard/dashboard:widget.not_seen', status: 'ready', days: 14, count: 1,
        members: [{ memberId: '01900000-0000-7000-8000-000000000001', firstName: first, lastName: unbreakable('Last'), lastSeenAt: null }] },
      { id: 'members.portal-confirmations', titleKey: 'portal/access:waitingTitle', status: 'ready', kind: 'count', count: 1,
        items: [{ label, href: '/admin/members/01900000-0000-7000-8000-000000000001' }] }] } } });
  });
  await admin(page, sandbox, owner, '/admin');
  await expect(page.getByRole('link', { name: new RegExp('^' + first) })).toBeVisible();
  await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible();
  await noSideways(page, 'dashboard widgets');
});

test('the autocomplete wraps an option name with no break opportunity', async ({ page, sandboxes }) => {
  const { sandbox, owner } = await sandboxOwner(sandboxes), name = unbreakable('Family');
  await owner.json('/api/households', 'POST', { name });
  await admin(page, sandbox, owner, '/admin/members');
  await page.getByRole('button', { name: 'Add member', exact: true }).click();
  const combobox = page.getByRole('combobox', { name: 'Find household' });
  await combobox.fill(name.slice(0, 12));
  await expect(page.getByRole('option', { name })).toBeVisible();
  await noSideways(page, 'autocomplete options');
});

test('the billing catalog wraps a plan name with no break opportunity', async ({ page, sandboxes }) => {
  const { sandbox, owner } = await sandboxOwner(sandboxes), name = unbreakable('Plan');
  const currency = (await owner.json<{ data: { currency: string }[] }>('/api/billing/plans?limit=1')).data[0]?.currency ?? 'USD';
  await owner.json('/api/billing/plans', 'POST', { name, amountCents: 9900, currency, interval: 'monthly' });
  await admin(page, sandbox, owner, '/admin/billing/plans');
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await noSideways(page, 'billing catalog');
  // The edit form lists the tax rates and prices by name too.
  const edit = page.getByRole('button', { name: 'Edit ' + name, exact: true });
  await expect(edit).toHaveAttribute('data-name-wrap', '');
  await edit.click();
  await noSideways(page, 'billing catalog editor');
});

test('the campaigns list wraps a campaign name with no break opportunity', async ({ page, sandboxes }) => {
  const { sandbox, owner } = await sandboxOwner(sandboxes), name = unbreakable('Campaign');
  const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: unbreakable('Home') })).data;
  await owner.json('/api/link-campaigns', 'POST', { name, purpose: 'onboarding', expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    reminderSchedule: [], recipients: [{ householdId: home.id }] });
  await admin(page, sandbox, owner, '/admin/campaigns');
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await noSideways(page, 'campaigns list');
  const view = page.getByRole('button', { name: 'View ' + name, exact: true });
  await expect(view).toHaveAttribute('data-name-wrap', '');
  await view.click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await noSideways(page, 'campaign recipients');
});

test('the ranks page wraps a program name and keeps the status badge beside it whole', async ({ page, sandboxes }) => {
  const { sandbox, owner } = await sandboxOwner(sandboxes), name = unbreakable('Zetaprogram');
  const first = (await owner.json<{ data: Program[] }>('/api/programs?limit=100')).data.find((program) => program.rankSystemId)!;
  await owner.json('/api/programs', 'POST', { name, rankSystemId: first.rankSystemId, active: true });
  // A coach reads the programs as a list with a status badge; an owner edits them in forms.
  await admin(page, sandbox, await demoClient(sandbox, 'coach'), '/admin/ranks');
  const row = page.getByRole('listitem').filter({ hasText: name });
  await expect(row).toBeVisible();
  const badge = row.getByText('Active', { exact: true });
  await expect(badge).toBeVisible();
  expect(await onOneLine(badge), 'the badge keeps its word beside a long name').toBe(true);
  await noSideways(page, 'ranks page');
});

test('the member profile and its attendance breakdown wrap long names', async ({ page, sandboxes }) => {
  const { sandbox, owner } = await sandboxOwner(sandboxes), program = unbreakable('Zetabreakdown');
  const first = (await owner.json<{ data: Program[] }>('/api/programs?limit=100')).data.find((item) => item.rankSystemId)!;
  const created = (await owner.json<{ data: Program }>('/api/programs', 'POST', { name: program, rankSystemId: first.rankSystemId, active: true })).data;
  const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: unbreakable('Home') })).data;
  const lastName = unbreakable('Member').slice(0, 55);
  const member = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id, firstName: 'M', lastName, status: 'active' })).data;
  await owner.json('/api/attendance', 'POST', { memberId: member.id, sessionId: null, programId: created.id });
  await admin(page, sandbox, owner, '/admin/members/' + member.id);
  await expect(page.getByRole('heading', { level: 1, name: 'M ' + lastName })).toBeVisible();
  await noSideways(page, 'member profile');
  await page.getByRole('tab', { name: 'Attendance', exact: true }).click();
  const breakdown = page.getByRole('region', { name: 'Visits by program' });
  await expect(breakdown.getByText(program, { exact: true })).toBeVisible();
  // The table keeps its column width and scrolls in its own region, so a long program name can't widen the profile.
  await noSideways(page, 'attendance breakdown');
});

test('the portal schedule wraps class and member names with no break opportunity', async ({ page, sandboxes }, info) => {
  test.setTimeout(180_000);
  const { sandbox, owner } = await sandboxOwner(sandboxes), name = unbreakable('Unbreakable'), email = `wrap-${randomBytes(4).toString('hex')}@example.invalid`;
  const session = await createClass(owner, name);
  // A household of its own, with a portal login, so no seeded household gains a member, a booking or a class.
  const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: 'Wrap household', email })).data;
  await owner.json('/api/members', 'POST', { householdId: home.id, firstName: 'Pat', lastName: 'Payer', email, status: 'active' });
  // A household member whose name has no break opportunity either, booked into the class: the portal lists the household's places by member name.
  const longMember = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id, firstName: 'M',
    lastName: unbreakable('Member').slice(0, 55), status: 'active' })).data;
  await owner.json('/api/bookings', 'POST', { memberId: longMember.id, sessionId: session.id, allowWaitlist: false });
  await portalLogin(page, sandbox, owner, home.id, email);
  await page.goto(sandbox.origin + '/portal/schedule');
  await showPortalClass(page, page.getByText(name, { exact: true }));
  await expect(page.getByRole('heading', { name: 'Class schedule', exact: true })).toBeVisible();
  const loading = page.getByText('Loading classes…', { exact: true });
  await expect(loading).toHaveCount(0);
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await accessibleLayout(page, info, 'portal schedule');
  await page.getByText(name, { exact: true }).click();
  await expect(page.getByRole('list', { name: 'Household places' }).getByText(`${longMember.firstName} ${longMember.lastName}`, { exact: true })).toBeVisible();
  await accessibleLayout(page, info, 'portal class dialog');
});

test('portal progress shows a program with no rank yet, at 360 px and on desktop', async ({ page, sandboxes }, info) => {
  test.setTimeout(180_000);
  const { sandbox, owner } = await sandboxOwner(sandboxes), name = unbreakable('Noranks'), email = `norank-${randomBytes(4).toString('hex')}@example.invalid`;
  const first = (await owner.json<{ data: Program[] }>('/api/programs?limit=100')).data.find((program) => program.rankSystemId)!;
  const created = (await owner.json<{ data: RecordId }>('/api/programs', 'POST', { name, rankSystemId: first.rankSystemId, active: true })).data;
  const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: 'No-rank household', email })).data;
  const payer = (await owner.json<{ data: RecordId }>('/api/members', 'POST', { householdId: home.id, firstName: 'Pat', lastName: 'Payer', email, status: 'active' })).data;
  // A program shows only once the member holds a rank in it or has attended it.
  await owner.json('/api/attendance', 'POST', { memberId: payer.id, sessionId: null, programId: created.id });
  await portalLogin(page, sandbox, owner, home.id, email);
  await page.goto(sandbox.origin + '/portal/progress');
  const program = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(program.getByText('No rank yet in this program.', { exact: true })).toBeVisible();
  await expect(program.getByText(/^Next: /)).toBeVisible();
  await accessibleLayout(page, info, 'portal progress at 360 px');
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(program).toBeVisible();
  await accessibleLayout(page, info, 'portal progress on desktop');
});
