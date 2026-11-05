// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { test, expect, createClass, demoClient, Client, type Person, type Program, type RecordId, type Sandbox } from '../support.js';
import { accessibleLayout, horizontalOverflow } from '../responsive.js';
import { claimPortal, outboxIds, outboxLink } from '../portal.js';

// Cookies and links are bearer credentials. Keep them out of traces and screenshots.
test.use({ trace: 'off', screenshot: 'off', viewport: { width: 360, height: 740 } });

/** A 56-character name with no break opportunity: user-supplied text can be this long, and the page must wrap it. */
const unbreakable = (prefix: string) => (prefix + randomBytes(2).toString('hex')).padEnd(56, 'x');

async function noSideways(page: Page, surface: string) {
  expect(await horizontalOverflow(page), surface + ': horizontal scroll at 360 px').toBeUndefined();
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
  await page.getByRole('button', { name: 'Edit ' + name, exact: true }).click();
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
  await page.getByRole('button', { name: 'View ' + name, exact: true }).click();
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
  const invitation = await owner.json<{ data: { invitationUrl: string } }>(`/api/households/${home.id}/portal-invitations`, 'POST', { email, delivery: 'print', scope: 'payer' });
  const before = await outboxIds(owner);
  await new Client(sandbox.origin).json('/api/portal/invitations/accept', 'POST', { token: new URL(invitation.data.invitationUrl).hash.slice(1) });
  const portal = await claimPortal(sandbox.origin, await outboxLink(owner, email, /^\/api\/auth\//, before));
  await portal.browser(page.context());
  await page.goto(sandbox.origin + '/portal/schedule');
  await expect(page.getByRole('heading', { name: 'Class schedule', exact: true })).toBeVisible();
  const loading = page.getByText('Loading classes…', { exact: true });
  await expect(loading).toHaveCount(0);
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Household places' }).getByText(`${longMember.firstName} ${longMember.lastName}`, { exact: true })).toBeVisible();
  // The full layout check (axe, touch targets, horizontal scroll).
  await accessibleLayout(page, info, 'portal schedule');
});
