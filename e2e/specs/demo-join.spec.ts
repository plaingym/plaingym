// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { Browser, Locator, Page, TestInfo } from '@playwright/test';
import { test, expect, demoClient, type Client, type Person, type Program, type RecordId } from '../support.js';
import { accessibleLayout } from '../responsive.js';
import { deliverStripeEvent, fakeStripe, outboxIds, outboxLink, retryLimited, stripeOrigin } from '../portal.js';

// Join cookies, outbox sign-in links and the check-in code are bearer credentials. Keep them out of traces and screenshots.
test.use({ trace: 'off', screenshot: 'off' });
const phone = { width: 360, height: 740 }, desktop = { width: 1280, height: 800 };
interface Session extends RecordId { name: string; startsAt: string; endsAt: string }
interface Visitor { firstName: string; lastName: string; email: string; fullName: string }

/** Checks the page on desktop and at 360 px, ending at the phone width the flow runs at. */
async function bothWidths(page: Page, info: TestInfo, name: string) {
  for (const size of [desktop, phone]) {
    await page.setViewportSize(size);
    await accessibleLayout(page, info, `${name}-${size.width}`);
  }
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
/** A class in the portal schedule's current or next week. */
async function portalClass(page: Page, button: string) {
  const target = page.getByRole('button', { name: button, exact: true }), loading = page.getByText('Loading classes…', { exact: true });
  await expect(page.getByRole('heading', { name: 'Class schedule', exact: true })).toBeVisible();
  await expect(loading).toHaveCount(0);
  if (!await target.isVisible()) {
    await page.getByRole('button', { name: 'Next week', exact: true }).click();
    await expect(loading).toHaveCount(0);
    await expect(target).toBeVisible();
  }
  return target;
}
function newVisitor(): Visitor {
  const lastName = 'Visitor' + randomBytes(3).toString('hex');
  return { firstName: 'Riley', lastName, email: `join-${randomBytes(6).toString('hex')}@example.invalid`, fullName: 'Riley ' + lastName };
}
const joined = async (owner: Client, visitor: Visitor) =>
  (await owner.json<{ data: (Person & { status: string })[] }>('/api/members?search=' + visitor.lastName)).data;

/** Chooses the first plan on /join, signs every current document as the adult joining, and submits. */
async function join(page: Page, info: TestInfo, origin: string, visitor: Visitor) {
  await page.setViewportSize(phone);
  await page.goto(origin + '/join');
  await expect(page.getByRole('heading', { name: 'Join', exact: true })).toBeVisible();
  await bothWidths(page, info, 'join-plans');
  await page.getByRole('link', { name: /^Choose / }).first().click();
  await expect(page.getByRole('heading', { name: /^Join: / })).toBeVisible();
  await page.getByLabel('Contact or parent/guardian name', { exact: true }).fill(visitor.fullName);
  await page.getByLabel('Email', { exact: true }).fill(visitor.email);
  await page.getByLabel('First name', { exact: true }).fill(visitor.firstName);
  await page.getByLabel('Last name', { exact: true }).fill(visitor.lastName);
  await page.getByLabel('Date of birth', { exact: true }).fill('1994-05-06');
  // Only the visible documents belong to the chosen household size.
  const waivers = page.locator('fieldset[data-waiver]:visible');
  expect(await waivers.count()).toBeGreaterThan(0);
  for (const waiver of await waivers.all()) {
    await waiver.getByRole('combobox', { name: 'Who is signing?', exact: true }).selectOption({ label: 'I am this adult participant' });
    await waiver.getByLabel('Signer full name', { exact: true }).fill(visitor.fullName);
    await sign(waiver.locator('canvas'), page);
    await waiver.getByLabel('I have read and agree to this document.', { exact: true }).check();
  }
  await bothWidths(page, info, 'join-form');
  // With scripts, the saved form continues straight to Checkout.
  await page.getByRole('button', { name: 'Continue to payment', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/join/checkout' || url.origin === stripeOrigin);
}
/** Follows the join's passwordless sign-in link from the sandbox outbox into the portal. */
async function signInToPortal(page: Page, info: TestInfo, owner: Client, visitor: Visitor, before: Set<string>) {
  const signIn = await outboxLink(owner, visitor.email, /^\/api\/auth\//, before);
  const opened = await retryLimited(async () => {
    const response = await page.goto(signIn.href), retry = Number((await response?.allHeaders())?.['x-retry-after'] ?? NaN);
    return { status: response?.status() ?? 0, ...(Number.isFinite(retry) ? { retryAfter: retry } : {}) };
  });
  expect(opened.status).not.toBe(429);
  await page.waitForURL(url => url.pathname.startsWith('/portal') && !url.pathname.startsWith('/portal/claim'));
  await expect(page.getByRole('heading', { name: 'Welcome to your member portal', exact: true })).toBeVisible();
  await bothWidths(page, info, 'portal-home');
}

// Both tests use the run's second sandbox, created fresh by this run: sandbox creation allows three per address an hour.
test('a visitor joins with the test card, and only the signed checkout webhook activates the join and its portal login', async ({ page, sandboxes }, info) => {
  test.setTimeout(180_000);
  const sandbox = sandboxes[1]!, owner = await demoClient(sandbox, 'owner'), visitor = newVisitor();
  await join(page, info, sandbox.origin, visitor);
  // Checkout is hosted by the payment provider; in this stack the fake's page takes the test card.
  await page.waitForURL(url => url.origin === stripeOrigin, { timeout: 5_000 });
  const sessionId = new URL(page.url()).pathname.split('/').pop()!;
  await page.getByLabel('Card number', { exact: true }).fill('4242 4242 4242 4242');
  await page.getByRole('button', { name: 'Pay', exact: true }).click();
  await page.waitForURL(url => url.origin === sandbox.origin && url.pathname === '/join/return');
  await expect(page.getByRole('heading', { name: 'Confirming your payment', exact: true })).toBeVisible();
  // Returning from Checkout grants nothing; only the webhook's recorded payment does.
  expect((await joined(owner, visitor)).map(member => member.status)).toEqual(['prospect']);
  const before = await outboxIds(owner);
  const session = await fakeStripe().json<Record<string, unknown>>('/v1/checkout/sessions/' + sessionId);
  expect(session).toMatchObject({ status: 'complete', metadata: { gym_id: sandbox.gymId } });
  await deliverStripeEvent('checkout.session.completed', session);
  await expect(page.getByRole('heading', { name: 'Welcome', exact: true })).toBeVisible({ timeout: 30_000 });
  await bothWidths(page, info, 'join-welcome');
  expect((await joined(owner, visitor)).map(member => member.status)).toEqual(['active']);
  await signInToPortal(page, info, owner, visitor, before);
});

test('a joined visitor books, is promoted from the waitlist, checks in by QR code on the coach roster, and can install the portal', async ({ page, browser, sandboxes }, info) => {
  test.setTimeout(300_000);
  const sandbox = sandboxes[1]!, owner = await demoClient(sandbox, 'owner'), visitor = newVisitor();
  // Staff record the join's first invoice paid at the desk; the same completion then activates the join.
  await join(page, info, sandbox.origin, visitor);
  const [prospect] = await joined(owner, visitor);
  expect(prospect).toMatchObject({ status: 'prospect' });
  const [invoice] = (await owner.json<{ data: (RecordId & { amountCents: number; currency: string; status: string })[] }>(
    '/api/billing/invoices?householdId=' + prospect!.householdId)).data;
  expect(invoice).toMatchObject({ status: 'open' });
  const before = await outboxIds(owner);
  await owner.json(`/api/billing/invoices/${invoice!.id}/payments`, 'POST', { amountCents: invoice!.amountCents, currency: invoice!.currency,
    method: 'cash', reference: null, paidAt: new Date().toISOString() });
  await page.goto(sandbox.origin + '/join/return');
  await expect(page.getByRole('heading', { name: 'Welcome', exact: true })).toBeVisible({ timeout: 30_000 });
  await bothWidths(page, info, 'join-welcome');
  const [member] = await joined(owner, visitor);
  expect(member).toMatchObject({ status: 'active' });
  await signInToPortal(page, info, owner, visitor, before);

  // The portal installs as an app at phone width: a valid manifest and a service worker for /portal.
  const cdp = await page.context().newCDPSession(page);
  await expect.poll(async () => (await cdp.send('Page.getAppManifest')).url).toMatch(/\/portal\/manifest\.webmanifest$/);
  expect((await cdp.send('Page.getAppManifest')).errors).toEqual([]);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)).toBe(sandbox.origin + '/portal');
  await expect.poll(async () => (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);

  // Two classes: one starting soon to book and check in to, and a full one tomorrow to wait for.
  const bootstrap = await owner.json<{ data: { gym: { timezone: string } } }>('/api/auth/bootstrap');
  const program = (await owner.json<{ data: Program[] }>('/api/programs?limit=100')).data[0]!;
  const minute = 60_000, start = Math.ceil(Date.now() / (5 * minute)) * 5 * minute + 30 * minute;
  const create = async (name: string, startsAt: number, capacity: number) => (await owner.json<{ data: Session }>('/api/schedule/sessions', 'POST', {
    name, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(startsAt + 60 * minute).toISOString(), coachId: null, capacity,
    notes: null, kind: 'class', programIds: [program.id], tagIds: [] })).data;
  const tag = randomBytes(2).toString('hex'), soon = await create(`Join check-in ${tag}`, start, 10);
  const full = await create(`Join waitlist ${tag}`, start + 26 * 60 * minute, 1);
  const holderHome = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: 'Waitlist holder ' + tag })).data;
  const holder = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: holderHome.id, firstName: 'Holder', lastName: tag })).data;
  const held = (await owner.json<{ data: RecordId & { status: string } }>('/api/bookings', 'POST', { memberId: holder.id, sessionId: full.id, allowWaitlist: false })).data;
  expect(held.status).toBe('booked');

  // Book the class starting soon, then join the full class's waitlist.
  await page.goto(sandbox.origin + '/portal/schedule');
  await expect(page.getByRole('heading', { name: 'Class schedule', exact: true })).toBeVisible();
  await (await portalClass(page, `Book ${soon.name} for ${visitor.fullName}`)).click();
  // The class starts within the cancellation cutoff, so the place shows as booked without a cancel action.
  const booked = page.getByRole('listitem').filter({ has: page.getByText(soon.name, { exact: true }) });
  await expect(booked.getByRole('list', { name: 'Household places', exact: true })).toHaveText(new RegExp(`^${visitor.fullName}\\s*Booked$`));
  await page.goto(sandbox.origin + '/portal/schedule');
  await (await portalClass(page, `Join the waitlist: ${full.name} for ${visitor.fullName}`)).click();
  await expect(page.getByRole('button', { name: `Leave the waitlist: ${full.name} for ${visitor.fullName}`, exact: true })).toBeVisible();
  await expect(page.getByText('Waitlist — position 1', { exact: true })).toBeVisible();
  await bothWidths(page, info, 'portal-schedule');

  // Staff cancel the held place; the waitlist promotes the visitor.
  await owner.json(`/api/bookings/${held.id}/cancel`, 'POST', {});
  await expect.poll(async () => {
    await page.goto(sandbox.origin + '/portal/schedule');
    return (await portalClass(page, `Cancel booking: ${full.name} for ${visitor.fullName}`).catch(() => undefined)) !== undefined;
  }, { timeout: 60_000, message: 'The waitlist promotes the visitor' }).toBe(true);

  // The portal shows a QR check-in code; the sandbox kiosk scans it from its camera.
  await page.goto(sandbox.origin + '/portal/checkin');
  await expect(page.getByRole('heading', { name: 'Check-in code', exact: true })).toBeVisible();
  const image = page.getByRole('img', { name: `QR check-in code for ${visitor.fullName}`, exact: true });
  const createCode = page.getByRole('button', { name: 'Create a code', exact: true });
  await expect(image.or(createCode)).toBeVisible();
  if (await createCode.isVisible()) await createCode.click();
  await expect(image).toBeVisible();
  await bothWidths(page, info, 'portal-checkin');
  await checkInAtKiosk(browser, sandbox.origin, sandbox.kioskToken, (await image.getAttribute('src'))!, `${visitor.firstName} ${visitor.lastName[0]}.`);

  // The coach's roster for the class shows the visitor checked in.
  const coach = await demoClient(sandbox, 'coach');
  const roster = await coach.json<{ data: { booking: { memberId: string } | null; attendance: { memberId: string } | null }[] }>(
    `/api/bookings/sessions/${soon.id}/roster?limit=100`);
  expect(roster.data.find(entry => entry.booking?.memberId === member!.id)?.attendance?.memberId).toBe(member!.id);
  const coachContext = await browser.newContext({ viewport: phone, timezoneId: bootstrap.data.gym.timezone });
  try {
    await coach.browser(coachContext);
    const coachPage = await coachContext.newPage();
    await coachPage.goto(sandbox.origin + '/admin/schedule');
    await coachPage.getByRole('button', { name: new RegExp(`^\\d{2}:\\d{2}–\\d{2}:\\d{2} ${soon.name}`) }).first().click();
    const bookings = coachPage.getByRole('region', { name: 'Bookings and check-ins', exact: true });
    await expect(bookings.getByText(visitor.fullName)).toBeVisible();
    await expect(bookings.getByText('Checked in', { exact: true }).first()).toBeVisible();
    await bothWidths(coachPage, info, 'coach-roster');
  } finally { await coachContext.close(); }
});

test("the portal schedule's booking actions keep their visible text in their accessible names (WCAG 2.5.3)", async ({ page, sandboxes }) => {
  const sandbox = sandboxes[0]!, student = await demoClient(sandbox, 'student');
  await student.browser(page.context());
  await page.setViewportSize(phone);
  await page.goto(sandbox.origin + '/portal/schedule');
  // The seeded student holds booked places and a waitlist place.
  await expect(page.getByRole('button', { name: /^Leave the waitlist: / }).first()).toBeVisible();
  const result = await new AxeBuilder({ page }).withRules(['label-content-name-mismatch']).analyze();
  const mismatched = result.violations.flatMap(violation => violation.nodes.map(node => node.html));
  expect(mismatched).toEqual([]);
});

/** A kiosk tablet whose camera sees the portal's QR image: the kiosk decodes real frames, as from a phone screen. */
async function checkInAtKiosk(browser: Browser, origin: string, token: string, image: string, shown: string) {
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 }, hasTouch: true });
  try {
    await context.addInitScript((source) => {
      navigator.mediaDevices.getUserMedia = async () => {
        const canvas = document.createElement('canvas'), picture = new Image();
        canvas.width = 640; canvas.height = 480;
        picture.src = source; await picture.decode();
        const draw = () => {
          const context = canvas.getContext('2d')!;
          context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(picture, 160, 80, 320, 320);
        };
        draw(); setInterval(draw, 100);
        return canvas.captureStream(10);
      };
    }, image);
    const kiosk = await context.newPage();
    await kiosk.goto(origin + '/kiosk#kioskToken=' + token);
    await kiosk.getByRole('button', { name: 'Scan a QR code', exact: true }).click();
    await expect(kiosk.getByText(shown, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(kiosk.getByText('Checked in', { exact: true })).toBeVisible();
  } finally { await context.close(); }
}
