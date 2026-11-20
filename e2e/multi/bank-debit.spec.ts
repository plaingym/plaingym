// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { claimPortal, fakeStripe, stripeOrigin } from '../portal.js';
import { horizontalOverflow } from '../responsive.js';
import { expect, test as base, type Person } from '../support.js';
import { deliverStripeEvent, mailIds, mailLink, multiGyms, stripeAs, type Context } from './support.js';

type StripeObject = Record<string, unknown>;
type Invoice = { id: string; status: string };
const readSettings = (gym: Context) => gym.owner.json<{ data: { bankDebitsEnabled: boolean; revision: number } }>('/api/settings');
const test = base.extend<{ alpha: Context }>({
  alpha: async ({ browserName: _browserName }, use) => {
    const [alpha] = await multiGyms();
    try {
      expect((await readSettings(alpha)).data.bankDebitsEnabled).toBe(false);
      await use(alpha);
    } finally {
      const { data: { bankDebitsEnabled, revision } } = await readSettings(alpha);
      if (bankDebitsEnabled) {
        await alpha.owner.json('/api/settings/payments/bank-debits', 'PUT', { revision, bankDebitsEnabled: false });
        expect((await readSettings(alpha)).data.bankDebitsEnabled).toBe(false);
      }
    }
  },
});

// The join continuation cookie and the member's emailed sign-in link are bearer credentials.
test.use({ trace: 'off', screenshot: 'off' });
test.describe.configure({ timeout: 180_000 });

async function openBankCheckout(page: Page, alpha: Context, last: string, email: string) {
  const full = 'Riley ' + last;
  await page.goto(alpha.origin + '/join');
  const plan = alpha.name + ' monthly';
  await expect(page.getByRole('heading', { name: plan, exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Choose ' + plan, exact: true }).click();
  await page.getByLabel('Contact or parent/guardian name', { exact: true }).fill(full);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('First name', { exact: true }).fill('Riley');
  await page.getByLabel('Last name', { exact: true }).fill(last);
  await page.getByLabel('Date of birth', { exact: true }).fill('1994-05-06');

  const waiver = page.locator('fieldset[data-waiver]:visible');
  await expect(waiver).toHaveCount(1);
  await waiver.getByRole('combobox', { name: 'Who is signing?', exact: true }).selectOption({ label: 'I am this adult participant' });
  await waiver.getByLabel('Signer full name', { exact: true }).fill(full);
  const canvas = waiver.locator('canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.7);
  await page.mouse.down();
  for (const step of [0.3, 0.45, 0.6, 0.75, 0.85]) await page.mouse.move(box.x + box.width * step, box.y + box.height * (step % 0.3 + 0.3), { steps: 4 });
  await page.mouse.up();
  await waiver.getByLabel('I have read and agree to this document.', { exact: true }).check();

  await page.getByRole('button', { name: 'Continue to payment', exact: true }).click();
  await page.waitForURL(url => url.origin === stripeOrigin, { timeout: 15_000 });
  await expect(page.getByLabel('Card number', { exact: true })).toBeVisible();
}

const phone = { width: 360, height: 740 };
const desktop = { width: 1024, height: 768 };
for (const { title, viewport, outcome } of [
  { title: 'a bank join settles successfully', viewport: desktop, outcome: 'succeeded' },
  { title: 'a bank join goes past due after insufficient funds', viewport: desktop, outcome: 'insufficient_funds' },
  { title: 'a bank join settles successfully at 360px', viewport: phone, outcome: 'succeeded' },
] as const) {
  test('alpha: ' + title, async ({ alpha, browser, context, page: admin }, info) => {
    await admin.setViewportSize(viewport);
    await alpha.owner.browser(context);
    await admin.goto(alpha.origin + '/admin/settings');
    await admin.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Integrations', exact: true }).click();
    await expect(admin.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
    const bankSwitch = admin.getByRole('switch', { name: 'Accept bank payments', exact: true });
    await expect(bankSwitch).toBeEnabled();
    await expect(bankSwitch).not.toBeChecked();
    await bankSwitch.click();
    await expect(bankSwitch).toBeChecked();
    await expect(bankSwitch).toBeEnabled();
    expect((await readSettings(alpha)).data.bankDebitsEnabled).toBe(true);

    const visitorContext = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
    try {
      const page = await visitorContext.newPage();
      const last = 'BankVisitor' + randomBytes(3).toString('hex');
      const email = `bank-join-${randomBytes(6).toString('hex')}@example.invalid`;
      await openBankCheckout(page, alpha, last, email);
      const sessionId = new URL(page.url()).pathname.split('/').pop()!;
      const bank = page.getByRole('button', { name: 'US bank account', exact: true });
      await expect(bank).toBeVisible();
      expect(await horizontalOverflow(page)).toBeUndefined();
      if (outcome === 'succeeded') {
        await info.attach('bank-checkout-' + viewport.width, { body: await page.screenshot(), contentType: 'image/png' });
      }
      await bank.click();
      await page.waitForURL(url => url.origin === alpha.origin && url.pathname === '/join/return');
      await expect(page.getByRole('heading', { name: 'Confirming your payment', exact: true })).toBeVisible();

      const stripe = stripeAs(alpha.stripeKey);
      const session = await stripe.json<StripeObject & { payment_intent: string }>('/v1/checkout/sessions/' + sessionId);
      expect(session).toMatchObject({ status: 'complete', payment_status: 'unpaid', metadata: { gym_id: alpha.gymId } });
      const intent = await stripe.json<StripeObject & { payment_method: string }>('/v1/payment_intents/' + session.payment_intent);
      expect(intent).toMatchObject({ status: 'processing' });
      expect(await stripe.json('/v1/payment_methods/' + intent.payment_method)).toMatchObject({
        type: 'us_bank_account', customer: session.customer, us_bank_account: { bank_name: 'STRIPE TEST BANK', last4: '6789' },
      });
      const before = await mailIds();
      await deliverStripeEvent('checkout.session.completed', session, alpha);
      await deliverStripeEvent('payment_intent.processing', intent, alpha);
      await expect(page.getByText(/^Your bank payment is processing\./)).toBeVisible({ timeout: 30_000 });
      const link = await mailLink(email, /^\/api\/auth\//, before);
      expect(link.origin).toBe(alpha.origin);
      const visitor = await claimPortal(alpha.origin, link);
      await visitor.browser(visitorContext);
      await page.goto(alpha.origin + '/portal');
      await expect(page.getByRole('heading', { name: 'Welcome to your member portal', exact: true })).toBeVisible();
      expect((await visitor.json<{ data: Person[] }>('/api/portal/members')).data.map(member => member.lastName)).toEqual([last]);

      const { data: members } = await alpha.owner.json<{ data: Person[] }>('/api/members?search=' + last);
      expect(members).toHaveLength(1);
      const member = members[0]!;
      const invoices = () => alpha.owner.json<{ data: Invoice[] }>('/api/billing/invoices?householdId=' + member.householdId);
      const { data: householdInvoices } = await invoices();
      expect(householdInvoices).toHaveLength(1);
      const invoicePath = '/admin/billing/invoices/' + householdInvoices[0]!.id;
      const invoiceStatus = (label: string) => admin.locator('dd').getByText(label, { exact: true });
      await admin.goto(alpha.origin + invoicePath);
      await expect(invoiceStatus('Processing')).toBeVisible();
      await admin.goto(alpha.origin + '/admin/members/' + member.id + '#memberTabs.invoices');
      await expect(admin.getByText('STRIPE TEST BANK account ending 6789', { exact: true })).toBeVisible();

      const settled = await fakeStripe().json<{ session: StripeObject; intent: StripeObject }>(
        '/test/settle-bank-checkout', 'POST', { key: alpha.stripeKey, sessionId, outcome });
      const paid = outcome === 'succeeded';
      await deliverStripeEvent(paid ? 'payment_intent.succeeded' : 'payment_intent.payment_failed', settled.intent, alpha);
      await deliverStripeEvent(paid ? 'checkout.session.async_payment_succeeded' : 'checkout.session.async_payment_failed', settled.session, alpha);
      await expect.poll(async () => (await invoices()).data[0]?.status, { timeout: 30_000 }).toBe(paid ? 'paid' : 'past_due');
      await admin.goto(alpha.origin + invoicePath);
      await expect(invoiceStatus(paid ? 'Paid' : 'Past due')).toBeVisible();
    } finally {
      await visitorContext.close();
    }
  });
}
