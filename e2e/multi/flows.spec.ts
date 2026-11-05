// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { test, expect, Client, gymTimezone, showWeek, type Person, type RecordId } from '../support.js';
import { claimPortal } from '../portal.js';
import { stripeOrigin } from '../portal.js';
import { mailIds, mailLink, multiGyms, postStripeEvent, signStripeEvent, deliverStripeEvent, stripeAs, withCookie, type Context } from './support.js';

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
    // The gym's own class, created with the date helpers, shows in its week; a page with no classes at all would not pass.
    await page.goto(own.origin + '/admin/schedule');
    await expect(page.getByRole('heading', { name: 'Schedule', exact: true })).toBeVisible();
    await showWeek(page, await gymTimezone(own.owner), Date.parse(own.session.startsAt));
    await expect(page.getByText(own.sessionName).first()).toBeVisible();
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
    // The class is in the portal's current or next week, whichever day the run starts.
    const loading = page.getByText('Loading classes…', { exact: true }), ownClass = page.getByText(own.sessionName).first();
    await expect(loading).toHaveCount(0);
    if (!await ownClass.isVisible()) {
      await page.getByRole('button', { name: 'Next week', exact: true }).click();
      await expect(loading).toHaveCount(0);
    }
    await expect(ownClass).toBeVisible();
    await expectOnlyOwn(page, own, other, 'the portal schedule');
    const household = await own.household.json<{ data: { id: string } }>('/api/portal/household');
    expect(household.data.id).toBe(own.householdId);
    const members = await own.household.json<{ data: Person[] }>('/api/portal/members');
    expect(members.data.map((member) => member.id)).toEqual([own.student.id]);
    const invoices = await own.household.json<{ data: RecordId[] }>('/api/portal/invoices?limit=100&offset=0');
    // The household's invoices: the open one and the one paid at the desk, and none of the other gym's.
    const mine = invoices.data.map((invoice) => invoice.id);
    expect(mine).toEqual(expect.arrayContaining([own.invoiceId, own.paidInvoiceId]));
    const theirs = (await other.owner.json<{ data: RecordId[] }>('/api/billing/invoices?limit=100')).data.map((invoice) => invoice.id);
    expect(theirs.length).toBeGreaterThan(0);
    expect(mine.filter((id) => theirs.includes(id))).toEqual([]);
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
    // The gym's own Checkout, on the fake Stripe's hosted page: the visitor pays with the test card there.
    await page.waitForURL((url) => url.origin === stripeOrigin, { timeout: 15_000 });
    const sessionId = new URL(page.url()).pathname.split('/').pop()!;
    // The prospect exists in this gym only.
    const prospects = async (gym: Context) => (await gym.owner.json<{ data: (Person & { status: string })[] }>('/api/members?search=' + last)).data;
    expect((await prospects(own)).map((member) => member.status)).toEqual(['prospect']);
    expect(await prospects(other)).toEqual([]);
    await page.getByLabel('Card number', { exact: true }).fill('4242 4242 4242 4242');
    await page.getByRole('button', { name: 'Pay', exact: true }).click();
    await page.waitForURL((url) => url.origin === own.origin && url.pathname === '/join/return');
    await expect(page.getByRole('heading', { name: 'Confirming your payment', exact: true })).toBeVisible();
    // Returning from Checkout grants nothing; only the gym's signed webhook does. The session lives in this gym's Stripe account alone.
    expect((await prospects(own)).map((member) => member.status)).toEqual(['prospect']);
    const session = await stripeAs(own.stripeKey).json<Record<string, unknown>>('/v1/checkout/sessions/' + sessionId);
    expect(session).toMatchObject({ status: 'complete', mode: 'payment', metadata: { gym_id: own.gymId } });
    expect((await stripeAs(other.stripeKey).request('/v1/checkout/sessions/' + sessionId)).status).toBe(404);
    // An event signed with the other gym's secret is refused by this gym's endpoint (the same event, from the other gym's account);
    // so is one signed for this gym but sent to the other gym's endpoint.
    const forged = await signStripeEvent(other, 'checkout.session.completed', session);
    expect((await postStripeEvent(own.origin, forged)).status).toBe(400);
    const misdirected = await signStripeEvent(own, 'checkout.session.completed', session);
    expect((await postStripeEvent(other.origin, misdirected)).status).toBe(400);
    expect((await prospects(own)).map((member) => member.status)).toEqual(['prospect']);
    const before = await mailIds();
    await deliverStripeEvent(own, 'checkout.session.completed', session);
    await expect(page.getByRole('heading', { name: 'Welcome', exact: true })).toBeVisible({ timeout: 30_000 });
    expect((await prospects(own)).map((member) => member.status)).toEqual(['active']);
    expect(await prospects(other)).toEqual([]);
    // The card payment is in this gym's ledger, and not in the other's.
    const [member] = await prospects(own);
    const [invoice] = (await own.owner.json<{ data: { id: string; status: string }[] }>('/api/billing/invoices?householdId=' + member!.householdId)).data;
    expect(invoice).toMatchObject({ status: 'paid' });
    const payments = async (gym: Context) => (await gym.owner.json<{ data: { invoiceId: string }[] }>('/api/billing/payments?limit=100')).data;
    expect((await payments(own)).some((payment) => payment.invoiceId === invoice!.id)).toBe(true);
    expect((await payments(other)).some((payment) => payment.invoiceId === invoice!.id)).toBe(false);
    // The emailed sign-in link opens this gym's portal.
    const link = await mailLink(email, /^\/api\/auth\//, before);
    expect(link.origin).toBe(own.origin);
    const visitor = await claimPortal(own.origin, link);
    expect((await visitor.json<{ data: { name: string } }>('/api/portal/household')).data).toBeDefined();
    expect((await visitor.json<{ data: Person[] }>('/api/portal/members')).data.map((member) => member.lastName)).toEqual([last]);
    expect([401, 403, 404]).toContain((await withCookie(other.origin, visitor.cookie).request('/api/portal/household')).status);
  });
}

// After both gyms' paid joins: each gym's Stripe account holds its own customers, Checkout sessions and cards, and its key reads nothing of the other's.
test('each gym\'s Stripe key reaches its own objects only', async () => {
  const [alpha, beta] = await multiGyms();
  const kinds = ['customers', 'checkout/sessions', 'payment_methods', 'payment_intents', 'charges', 'setup_intents', 'refunds'];
  interface Listed { id: string; metadata?: { gym_id?: string } }
  const held = async (gym: Context) => Object.fromEntries(await Promise.all(kinds.map(async (kind) =>
    [kind, (await stripeAs(gym.stripeKey).json<{ data: Listed[] }>(`/v1/${kind}?limit=100`)).data] as const)));
  const [alphaHeld, betaHeld] = [await held(alpha), await held(beta)];
  for (const [own, other, mine, theirs] of [[alpha, beta, alphaHeld, betaHeld], [beta, alpha, betaHeld, alphaHeld]] as const) {
    // Each gym joined a visitor by card and saved a household card, so these hold something.
    for (const kind of ['customers', 'checkout/sessions', 'payment_methods', 'payment_intents'])
      expect(mine[kind]!.length, `${own.slug}'s account holds ${kind}`).toBeGreaterThan(0);
    for (const kind of kinds) {
      const ids = new Set(mine[kind]!.map((object) => object.id));
      expect(theirs[kind]!.filter((object) => ids.has(object.id)), `${kind} in both accounts`).toEqual([]);
      // Objects the gym tagged with a gym are tagged with its own.
      for (const object of mine[kind]!) if (object.metadata?.gym_id) expect(object.metadata.gym_id, `${own.slug}'s ${kind}`).toBe(own.gymId);
      // The other key can't read any of them by ID.
      for (const object of mine[kind]!) expect((await stripeAs(other.stripeKey).request(`/v1/${kind}/${object.id}`)).status, `${other.slug}'s key reads ${kind}/${object.id}`).toBe(404);
    }
  }
});
