// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { test, expect, Client, type Person, type RecordId } from '../support.js';
import { claimPortal } from '../portal.js';
import { mailIds, mailLink, multiGyms, withCookie, type Context } from './support.js';

// Sign-in links, join cookies and device tokens are bearer credentials. Keep them out of traces and screenshots.
test.use({ trace: 'off', screenshot: 'off' });
const phone = { width: 360, height: 740 };

/** Everything that names a gym's own people, classes and plan: what the other gym must never show. */
const namesOf = (gym: Context) => [gym.name, gym.student.lastName, gym.sessionName, gym.householdId, gym.student.id, gym.planId, gym.program.name];
async function expectOnlyOwn(page: Page, own: Context, other: Context, where: string) {
  const text = await page.locator('body').innerText();
  for (const name of namesOf(other)) expect(text, `${where} shows ${name}`).not.toContain(name);
  expect(own.origin).toBe(new URL(page.url()).origin);
}
/** Draws one stroke on a waiver's signature canvas, as a finger would. */
async function sign(canvas: Locator, page: Page) {
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.7);
  await page.mouse.down();
  for (const step of [0.3, 0.45, 0.6, 0.75, 0.85]) await page.mouse.move(box.x + box.width * step, box.y + box.height * (step % 0.3 + 0.3), { steps: 4 });
  await page.mouse.up();
}

test.describe.configure({ mode: 'serial' });
for (const index of [0, 1] as const) {
  const title = (name: string) => `${index === 0 ? 'alpha' : 'beta'}: ${name}`;
  const gymsOf = async () => { const both = await multiGyms(); return { own: both[index], other: both[1 - index] }; };

  test(title('the admin shows only this gym, and a copied session works nowhere else'), async ({ page, context }) => {
    const { own, other } = await gymsOf();
    await own.owner.browser(context);
    await page.goto(own.origin + '/admin');
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    await page.goto(own.origin + '/admin/members');
    await expect(page.locator('body')).toContainText(own.student.lastName);
    await expectOnlyOwn(page, own, other, 'the member list');
    await page.goto(own.origin + '/admin/schedule');
    await expect(page.getByRole('heading', { name: 'Schedule', exact: true })).toBeVisible();
    await expectOnlyOwn(page, own, other, 'the schedule');
    const members = (await own.owner.json<{ data: Person[] }>('/api/members?limit=100')).data;
    expect(members.map((member) => member.id)).toEqual([own.student.id]);
    const bootstrap = await own.owner.json<{ data: { gym: { name: string }; session: { roles: string[] } } }>('/api/auth/bootstrap');
    expect(bootstrap.data.gym.name).toBe(own.name);
    expect(bootstrap.data.session.roles).toEqual(['owner']);
    // The same session cookie on the other gym's hostname is refused.
    const copied = withCookie(other.origin, own.cookies.owner);
    expect([401, 403]).toContain((await copied.request('/api/members')).status);
    expect([401, 403]).toContain((await copied.request('/api/auth/bootstrap')).status);
    // The coach is a coach in this gym only.
    const coach = await own.coach.json<{ data: { session: { roles: string[] } } }>('/api/auth/bootstrap');
    expect(coach.data.session.roles).toEqual(['coach']);
    expect((await own.coach.request('/api/staff/profiles')).status).toBe(403);
  });

  test(title('the member portal shows this household only'), async ({ page, context }) => {
    const { own, other } = await gymsOf();
    await own.household.browser(context);
    await page.goto(own.origin + '/portal');
    await expect(page.getByRole('heading', { name: 'Welcome to your member portal', exact: true })).toBeVisible();
    await page.goto(own.origin + '/portal/schedule');
    await expect(page.getByRole('heading', { name: 'Class schedule', exact: true })).toBeVisible();
    await expectOnlyOwn(page, own, other, 'the portal schedule');
    const household = await own.household.json<{ data: { id: string } }>('/api/portal/household');
    expect(household.data.id).toBe(own.householdId);
    const members = await own.household.json<{ data: Person[] }>('/api/portal/members');
    expect(members.data.map((member) => member.id)).toEqual([own.student.id]);
    const invoices = await own.household.json<{ data: RecordId[] }>('/api/portal/invoices?limit=100&offset=0');
    expect(invoices.data.map((invoice) => invoice.id)).toEqual([own.invoiceId]);
    // A household login has no staff access.
    expect([401, 403]).toContain((await own.household.request('/api/members')).status);
  });

  test(title('the kiosk checks in this gym\'s family by name and PIN, and no other'), async ({ browser }) => {
    const { own, other } = await gymsOf();
    const context = await browser.newContext({ viewport: { width: 768, height: 1024 }, hasTouch: true });
    try {
      const kiosk = await context.newPage();
      await kiosk.goto(own.origin + '/kiosk');
      await kiosk.getByLabel('Device token', { exact: true }).fill(own.kioskToken);
      await kiosk.getByRole('button', { name: 'Save and start check-in', exact: true }).click();
      await kiosk.getByRole('button', { name: 'Name and PIN', exact: true }).click();
      await kiosk.getByLabel('Your name', { exact: true }).fill(own.student.fullName);
      for (const digit of own.pin) await kiosk.getByRole('button', { name: digit, exact: true }).click();
      await kiosk.getByRole('button', { name: 'Find me', exact: true }).click();
      await expect(kiosk.getByRole('checkbox', { name: /Casey/ })).toBeVisible();
      await kiosk.getByRole('button', { name: 'Check in', exact: true }).click();
      // A class booked for the family is checked in directly; otherwise the family picks the open mat.
      const checked = kiosk.getByText(/Checked in|Already checked in/).first(), mat = kiosk.getByRole('button', { name: 'Open mat', exact: true }).first();
      await expect(checked.or(mat)).toBeVisible();
      if (await mat.isVisible()) for (const button of await kiosk.getByRole('button', { name: 'Open mat', exact: true }).all()) await button.click();
      await expect(checked).toBeVisible();
      await expectOnlyOwn(kiosk, own, other, 'the kiosk');
      // The kiosk starts over at the choice for the next family, with no name or PIN left behind.
      await expect(kiosk.getByRole('button', { name: 'Name and PIN', exact: true })).toBeVisible({ timeout: 30_000 });
      await kiosk.getByRole('button', { name: 'Name and PIN', exact: true }).click();
      await expect(kiosk.getByLabel('Your name', { exact: true })).toHaveValue('');
    } finally { await context.close(); }
    const mine = await own.owner.json<{ data: { memberId: string }[] }>('/api/attendance?limit=100');
    expect(mine.data.length).toBeGreaterThan(0);
    expect(mine.data.every((row) => row.memberId === own.student.id)).toBe(true);
    // This gym's tablet and PIN find nobody in the other gym, even by that gym's own family name.
    expect((await own.device.json<{ data: { status: string } }>('/api/kiosk/lookup', 'POST', { name: other.student.fullName, pin: other.pin })).data)
      .toEqual({ status: 'see_front_desk' });
    const copied = new Client(other.origin, { authorization: 'Bearer ' + own.kioskToken });
    expect((await copied.request('/api/kiosk/lookup', 'POST', { name: other.student.fullName, pin: other.pin })).status).toBe(404);
    expect((await other.owner.json<{ data: unknown[] }>('/api/attendance?limit=100')).data.every((row) => (row as { memberId: string }).memberId === other.student.id)).toBe(true);
  });

  test(title('a visitor joins this gym, and the other gym never learns of it'), async ({ page }) => {
    test.setTimeout(180_000);
    const { own, other } = await gymsOf();
    const last = 'Visitor' + randomBytes(3).toString('hex'), email = `join-${randomBytes(6).toString('hex')}@example.invalid`, full = 'Riley ' + last;
    await page.setViewportSize(phone);
    await page.goto(own.origin + '/join');
    await expect(page.getByRole('heading', { name: 'Join', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: own.name + ' monthly', exact: true })).toBeVisible();
    await expectOnlyOwn(page, own, other, 'the join page');
    await page.getByRole('link', { name: /^Choose / }).first().click();
    await expect(page.getByRole('heading', { name: /^Join: / })).toBeVisible();
    await page.getByLabel('Contact or parent/guardian name', { exact: true }).fill(full);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('First name', { exact: true }).fill('Riley');
    await page.getByLabel('Last name', { exact: true }).fill(last);
    await page.getByLabel('Date of birth', { exact: true }).fill('1994-05-06');
    const waivers = page.locator('fieldset[data-waiver]:visible');
    expect(await waivers.count()).toBe(1);
    await expect(waivers.first()).toContainText(own.name);
    for (const waiver of await waivers.all()) {
      await waiver.getByRole('combobox', { name: 'Who is signing?', exact: true }).selectOption({ label: 'I am this adult participant' });
      await waiver.getByLabel('Signer full name', { exact: true }).fill(full);
      await sign(waiver.locator('canvas'), page);
      await waiver.getByLabel('I have read and agree to this document.', { exact: true }).check();
    }
    await page.getByRole('button', { name: 'Continue to payment', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/join/checkout' || url.origin === 'https://stripe.localhost');
    // The prospect exists in this gym only; staff record the first invoice paid at the desk, which activates the join.
    const prospects = async (gym: Context) => (await gym.owner.json<{ data: (Person & { status: string })[] }>('/api/members?search=' + last)).data;
    const [prospect] = await prospects(own);
    expect(prospect).toMatchObject({ status: 'prospect' });
    expect(await prospects(other)).toEqual([]);
    const [invoice] = (await own.owner.json<{ data: (RecordId & { amountCents: number; currency: string })[] }>('/api/billing/invoices?householdId=' + prospect!.householdId)).data;
    const before = await mailIds();
    await own.owner.json(`/api/billing/invoices/${invoice!.id}/payments`, 'POST', { amountCents: invoice!.amountCents, currency: invoice!.currency,
      method: 'cash', reference: null, paidAt: new Date().toISOString() });
    await page.goto(own.origin + '/join/return');
    await expect(page.getByRole('heading', { name: 'Welcome', exact: true })).toBeVisible({ timeout: 30_000 });
    expect((await prospects(own)).map((member) => member.status)).toEqual(['active']);
    expect(await prospects(other)).toEqual([]);
    // The emailed sign-in link opens this gym's portal.
    const link = await mailLink(email, /^\/api\/auth\//, before);
    expect(link.origin).toBe(own.origin);
    const visitor = await claimPortal(own.origin, link);
    expect((await visitor.json<{ data: { name: string } }>('/api/portal/household')).data).toBeDefined();
    expect((await visitor.json<{ data: Person[] }>('/api/portal/members')).data.map((member) => member.lastName)).toEqual([last]);
    expect([401, 403, 404]).toContain((await withCookie(other.origin, visitor.cookie).request('/api/portal/household')).status);
  });
}
