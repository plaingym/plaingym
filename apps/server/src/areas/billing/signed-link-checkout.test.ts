// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, households, invoices, paymentMethods, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, createTranslator } from '@plaingym/shared';
import { TestClock } from '../../core/clock.js';
import { createApp } from '../../app.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakePayments, type CheckoutSession, type Payments } from '../../infra/payments/index.js';
import { StripePayments } from '../../infra/payments/stripe.js';
import { StripeFixtures } from '../../infra/payments/stripe-fixtures.js';
import { FixtureRecorder, type Tape } from '../../infra/payments/recording.js';
import { recordingTransport, replayTransport } from '../../infra/payments/transport.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createSignedLinksService } from '../links/service.js';
import { createCampaignsService } from '../links/campaigns.js';
import { createWaiversService } from '../waivers/waivers.js';
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';
import { createWebhookInbox, createWebhookHealthQuery } from './webhooks/inbox.js';
import { createWebhookInboxRoutes } from './webhooks/inbox.routes.js';
import { composeBillingWebhooks } from './webhooks/handlers/composition.js';
import { createSignedLinkCheckout } from './signed-link-checkout.js';

const db = useTestDatabase(), factory = createFactories(db);
const origin = 'https://gym.example.test', secret = 'synthetic-signing-secret';
async function fixture(purpose: 'pay_invoice' | 'update_card' | 'onboarding' = 'update_card', stripe = false) {
  const gymId = uuidv7(), clock = new TestClock('2026-10-27T12:00:00Z');
  await factory('gyms', gymId, { billingEnabled: true, memberEmailsEnabled: true });
  const household = await factory('households', gymId, { stripeCustomerId: 'cus_fixture', email: 'payer@example.test' });
  const member = await factory('members', gymId, { householdId: household.id });
  const invoice = await factory('invoices', gymId, { householdId: household.id, number: 1, status: 'open', amountCents: 100, kind: 'one_off' });
  const fake = new FakePayments(gymId, clock, secret), transport = new StripeFixtures(gymId, clock.now().getTime() / 1000);
  fake.seedCustomer({ id: 'cus_fixture', email: household.email! });
  let provider: Payments = stripe ? new StripePayments(gymId, { transport, clock, webhookSecret: secret }) : fake;
  const paymentsFor = async () => provider;
  const jobs = new FakeJobs(clock), email = new FakeEmail();
  const settings = createGymSettingsAccessor({ scope: db.forGym, clock });
  const links = createSignedLinksService({ scope: db.forGym, clock });
  const campaigns = createCampaignsService({ scope: db.forGym, clock, jobs, paymentsFor,
    delivery: { prepare: async () => ({ gymId, email, origin, gymName: 'Gym', memberEmailsEnabled: true, t: createTranslator({}) }) } });
  const context = { gymId, actor: { kind: 'system' as const } };
  const campaign = await factory('linkCampaigns', gymId, { purpose });
  const created = await links.create(context, { householdId: household.id, campaignId: campaign.id,
    expiresAt: '2026-11-27T12:00:00Z', ...(purpose === 'pay_invoice' ? { purpose, invoiceId: invoice.id } : { purpose }) });
  const linkId = created.link.id;
  const checkout = createSignedLinkCheckout({ scope: db.forGym, clock, paymentsFor, originFor: async () => origin });
  const callback = vi.fn(async (gym: string, link: string, session: string) => {
    try { await checkout.complete(gym, link, session); }
    catch (error) { if (!(error instanceof AppError && error.code === 'not_found')) throw error; }
  });
  const inbox = createWebhookInbox({ scope: db.forGym, system: db.forSystem, clock, jobs, gymSettings: settings, paymentsFor });
  composeBillingWebhooks({ scope: db.forGym, clock, inbox, jobs, settings, paymentsFor,
    afterCheckoutRecorded: callback, prepare: async () => ({ email, origin }), staffRecipients: async () => [] });
  const app = createApp({ clock, skipSetup: true, contributions: { routes: createWebhookInboxRoutes(inbox) },
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (_c, next) => { await next(); }, authorize: () => async (_c, next) => { await next(); } });
  const jobContext = { gymId, clock, timezone: 'UTC', attempt: 1, jobId: uuidv7() };
  async function deliver(session: CheckoutSession, type = 'checkout.session.completed', eventId = 'evt_' + uuidv7()) {
    const kind = type.startsWith('setup_') ? 'setup' : type.startsWith('payment_') ? 'charge' : 'checkout';
    const objectId = kind === 'setup' ? session.setupId! : kind === 'charge' ? session.chargeId! : session.id;
    const payload = stripe ? { id: eventId, object: 'event', type, livemode: false,
      data: { object: { id: objectId, object: kind === 'setup' ? 'setup_intent' : kind === 'charge' ? 'payment_intent' : 'checkout.session', metadata: { gym_id: gymId } } } }
      : { id: eventId, type, gymId, objectKind: kind, objectId };
    const body = JSON.stringify(payload), timestamp = Math.floor(clock.now().getTime() / 1000);
    const signature = stripe ? `t=${timestamp},v1=${createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex')}`
      : fake.signWebhook(new TextEncoder().encode(body));
    expect((await app.request(origin + '/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signature } })).status).toBe(200);
    return eventId;
  }
  async function finish(id: string) {
    if (!stripe) return fake.completeCheckout(id);
    if (transport.objects.has(id)) transport.completeCheckout(id);
    const found = await provider.readPaymentObject({ kind: 'checkout', id });
    if (found.status !== 'found' || found.value.kind !== 'checkout') throw new Error('Checkout missing');
    return found.value.object;
  }
  const used = () => db.forGym(gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'signed_link.used'), eq(auditEvents.targetId, linkId))));
  const dispatch = (eventId: string, replay = false) => inbox.dispatch({ eventId, replay }, jobContext);
  const health = () => createWebhookHealthQuery(db.forGym).get(gymId);
  return { gymId, clock, household, member, invoice, fake, transport, links, campaigns, campaign, context, created, linkId,
    checkout, callback, inbox, email, deliver, dispatch, finish, used, health,
    get provider() { return provider; },
    setProvider(value: Payments) { provider = value; } };
}

async function tapeFor(f: Awaited<ReturnType<typeof fixture>>, name: string, extraIds: string[] = []) {
  const location = new URL(`./signed-link-checkout.${name}.synthetic.json`, import.meta.url);
  const recording = process.env.RECORD_LINK_CHECKOUT_FIXTURES === '1', recorder = new FixtureRecorder(f.gymId);
  const ids = [f.gymId, f.invoice.id, f.linkId, ...extraIds];
  const placeholder = (index: number) => `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`;
  const bind = (body: string, replay: boolean) => ids.reduce((text, id, index) =>
    replay ? text.replaceAll(placeholder(index), id) : text.replaceAll(id, placeholder(index)), body);
  const replay = recording ? undefined : replayTransport(JSON.parse(bind(await readFile(location, 'utf8'), true)) as Tape, f.gymId);
  f.setProvider(new StripePayments(f.gymId, { clock: f.clock, webhookSecret: secret,
    transport: replay ?? recordingTransport(f.transport, recorder) }));
  return async () => {
    if (recording) await writeFile(location, bind(JSON.stringify({
      $comment: 'SPDX-License-Identifier: AGPL-3.0-only; synthetic Stripe API exchanges, no real account', ...recorder.tape,
    }, null, 2), false) + '\n');
    else replay!.assertConsumed();
  };
}

describe('signed-link audit regressions with real PostgreSQL', () => {
  for (const stripe of [false, true]) describe(stripe ? 'Stripe synthetic tapes' : 'fake provider', () => {
    async function payFixture() {
      const f = await fixture('pay_invoice', stripe);
      const b = await f.links.create(f.context, { purpose: 'pay_invoice', householdId: f.household.id,
        invoiceId: f.invoice.id, expiresAt: f.created.link.expiresAt });
      return Object.assign(f, { b });
    }
    it.each(['second', 'completed', 'same', 'same-completed'] as const)('recovers a lost Checkout response for the %s link path', async path => {
      const f = await payFixture(), done = stripe ? await tapeFor(f, 'lost-' + path, [f.b.link.id]) : async () => {};
      const create = f.provider.createCheckout.bind(f.provider);
      let lost: CheckoutSession | undefined;
      const calls = vi.spyOn(f.provider, 'createCheckout').mockImplementationOnce(async request => {
        lost = await create(request);
        throw new Error('Lost Checkout response');
      });
      await expect(f.checkout.start(f.gymId, f.linkId)).rejects.toThrow('Lost Checkout response');
      expect(lost).toBeDefined();
      const saved = () => db.forGym(f.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, f.invoice.id)));
      expect((await saved())[0]!.checkoutSessionId).toBeNull();
      if (path === 'completed' || path === 'same-completed') await f.finish(lost!.id);
      if (path === 'completed' || path === 'same-completed') {
        await expect(f.checkout.start(f.gymId, path === 'completed' ? f.b.link.id : f.linkId)).rejects.toMatchObject({ code: 'conflict' });
        expect((await saved())[0]!.checkoutSessionId).toBe(lost!.id);
        expect(calls).toHaveBeenCalledTimes(2);
      } else {
        const replacement = await f.checkout.start(f.gymId, path === 'same' ? f.linkId : f.b.link.id);
        expect(replacement.session.metadata.linkId).toBe(path === 'same' ? f.linkId : f.b.link.id);
        expect(replacement.session.id === lost!.id).toBe(path === 'same');
        expect(await f.provider.readPaymentObject({ kind: 'checkout', id: lost!.id }))
          .toMatchObject({ value: { object: { status: path === 'same' ? 'open' : 'expired' } } });
        if (path === 'second') {
          expect(calls.mock.calls[2]![0].idempotencyKey).not.toBe(calls.mock.calls[0]![0].idempotencyKey);
          expect(calls.mock.calls[2]![0].idempotencyKey).not.toContain(f.b.link.id);
        }
      }
      expect(calls.mock.calls[1]![0]).toEqual(calls.mock.calls[0]![0]);
      await done();
    });
    it('does not replay Checkout for another gym or a link pointing outside its household', async () => {
      const f = await payFixture(), otherGym = uuidv7();
      await factory('gyms', otherGym);
      const other = await factory('households', f.gymId);
      const create = vi.spyOn(f.provider, 'createCheckout');
      await expect(f.checkout.start(otherGym, f.linkId)).rejects.toMatchObject({ code: 'not_found' });
      await expect(f.links.create(f.context, { householdId: other.id, purpose: 'pay_invoice', invoiceId: f.invoice.id,
        expiresAt: f.created.link.expiresAt })).rejects.toMatchObject({ code: 'not_found' });
      expect(create).not.toHaveBeenCalled();
    });
    it('expires the abandoned link session and completes only the replacement link from its webhook', async () => {
      const f = await payFixture(), done = stripe ? await tapeFor(f, 'handover', [f.b.link.id]) : async () => {};
      const a = await f.checkout.start(f.gymId, f.linkId), b = await f.checkout.start(f.gymId, f.b.link.id);
      expect(b.session.id).not.toBe(a.session.id);
      expect(b.session.metadata.linkId).toBe(f.b.link.id);
      expect(await f.provider.readPaymentObject({ kind: 'checkout', id: a.session.id })).toMatchObject({ value: { object: { status: 'expired' } } });
      await f.dispatch(await f.deliver(await f.finish(b.session.id)));
      expect((await f.links.get(f.gymId, f.b.link.id)).usedAt).not.toBeNull();
      expect((await f.links.get(f.gymId, f.linkId)).usedAt).toBeNull();
      expect(await f.checkout.complete(f.gymId, f.linkId, b.session.id)).toBe(false);
      expect(await f.checkout.complete(f.gymId, f.linkId, null)).toBe(false);
      expect(await f.used()).toHaveLength(0);
      await done();
    });
    it('hands the open invoice back to A when A reopens, with one renewal per handover', async () => {
      const f = await payFixture(), done = stripe ? await tapeFor(f, 'handover-reverse', [f.b.link.id]) : async () => {};
      const a = await f.checkout.start(f.gymId, f.linkId), b = await f.checkout.start(f.gymId, f.b.link.id);
      const again = await f.checkout.start(f.gymId, f.linkId);
      expect(new Set([a.session.id, b.session.id, again.session.id]).size).toBe(3);
      expect(again.session.metadata.linkId).toBe(f.linkId);
      expect(await f.provider.readPaymentObject({ kind: 'checkout', id: b.session.id })).toMatchObject({ value: { object: { status: 'expired' } } });
      expect((await f.checkout.start(f.gymId, f.linkId)).session.id).toBe(again.session.id);
      const renewals = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.checkout.expired')));
      expect(renewals).toHaveLength(2);
      await done();
    });
    it.each([false, true])('returns conflict without a second session when payment wins (during expire: %s)', async racing => {
      const f = await payFixture(), done = stripe ? await tapeFor(f, racing ? 'handover-race' : 'handover-paid', [f.b.link.id]) : async () => {};
      const a = await f.checkout.start(f.gymId, f.linkId);
      if (!racing) await f.finish(a.session.id);
      else if (stripe) {
        const request = f.transport.request.bind(f.transport);
        vi.spyOn(f.transport, 'request').mockImplementation(async input => {
          if (input.path.endsWith('/expire')) f.transport.completeCheckout(a.session.id);
          return request(input);
        });
      } else vi.spyOn(f.fake, 'expireCheckout').mockImplementationOnce(async () =>
        ({ status: 'already_completed', session: f.fake.completeCheckout(a.session.id) }));
      const create = vi.spyOn(f.provider, 'createCheckout');
      await expect(f.checkout.start(f.gymId, f.b.link.id)).rejects.toMatchObject({ code: 'conflict', message: 'Checkout is no longer open' });
      expect(create).not.toHaveBeenCalled();
      expect((await db.forGym(f.gymId, tx => tx.select().from(invoices)))[0]!.checkoutSessionId).toBe(a.session.id);
      await done();
    });
    it('keeps an older untagged session shared when another invoice link starts', async () => {
      const f = await payFixture(), done = stripe ? await tapeFor(f, 'legacy-shared', [f.b.link.id]) : async () => {};
      const legacy = await f.provider.createCheckout({ mode: 'payment', customerId: f.household.stripeCustomerId!,
        invoiceId: f.invoice.id, amount: 100, currency: 'usd', saveForOffSession: false,
        successUrl: origin, cancelUrl: origin, idempotencyKey: 'legacy-shared' });
      await db.forGym(f.gymId, tx => tx.update(invoices).set({ checkoutSessionId: legacy.id,
        checkoutExpiresAt: new Date(f.clock.now().getTime() + 23 * 3600000) }).where(eq(invoices.id, f.invoice.id)));
      const expire = vi.spyOn(f.provider, 'expireCheckout');
      expect((await f.checkout.start(f.gymId, f.b.link.id)).session.id).toBe(legacy.id);
      expect(expire).not.toHaveBeenCalled();
      await done();
    });
    it.each(['pay_invoice', 'update_card', 'onboarding'] as const)('preserves legacy %s browser completion without a start association', async purpose => {
      const f = await fixture(purpose, stripe), done = stripe ? await tapeFor(f, 'legacy-' + purpose) : async () => {};
      const legacy = await f.provider.createCheckout({ mode: purpose === 'pay_invoice' ? 'payment' : 'setup',
        customerId: f.household.stripeCustomerId!, invoiceId: f.invoice.id, amount: 100, currency: 'usd', saveForOffSession: true,
        successUrl: origin, cancelUrl: origin, idempotencyKey: 'legacy' });
      const session = await f.finish(legacy.id);
      expect(await f.checkout.complete(f.gymId, f.linkId, session.id)).toBe(false); // Webhook writes are still required.
      await f.dispatch(await f.deliver(session));
      expect(f.callback).not.toHaveBeenCalled();
      if (purpose === 'onboarding') {
        const template = await factory('waiverTemplates', f.gymId);
        expect(await f.checkout.complete(f.gymId, f.linkId, session.id)).toBe(false);
        const uploads = new FakeUploads(f.gymId, f.clock);
        const waivers = createWaiversService({ scope: db.forGym, clock: f.clock, uploadsFor: async () => uploads });
        const image = await waivers.uploadSignedLink(f.gymId, f.linkId, f.member.id, demoSignaturePng());
        await waivers.signSignedLink(f.gymId, f.linkId, { memberId: f.member.id, templateId: template.id, templateVersion: template.version,
          ...image, consent: true, signer: { kind: 'guardian', name: 'Payer', relationship: 'Parent' } }, { timezone: 'UTC', ipAddress: 'unknown' });
        expect(await f.checkout.complete(f.gymId, f.linkId, session.id)).toBe(true);
      } else {
        if (purpose === 'update_card') {
          await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ revokedAt: f.clock.now(), isDefault: false }));
          expect(await f.checkout.complete(f.gymId, f.linkId, session.id)).toBe(false);
          await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ revokedAt: null }));
        }
        expect(await f.checkout.complete(f.gymId, f.linkId, session.id)).toBe(true);
        expect(await f.used()).toHaveLength(1);
      }
      await done();
    });
    it.each(['partially_refunded', 'refunded'] as const)('preserves legacy invoice completion after it is %s', async status => {
      const f = await fixture('pay_invoice', stripe), done = stripe ? await tapeFor(f, 'legacy-' + status) : async () => {};
      const legacy = await f.provider.createCheckout({ mode: 'payment', customerId: f.household.stripeCustomerId!,
        invoiceId: f.invoice.id, amount: 100, currency: 'usd', saveForOffSession: false,
        successUrl: origin, cancelUrl: origin, idempotencyKey: 'legacy' });
      const session = await f.finish(legacy.id);
      await f.dispatch(await f.deliver(session));
      await db.forGym(f.gymId, tx => tx.update(invoices).set({ status }).where(eq(invoices.id, f.invoice.id)));
      expect(await f.checkout.complete(f.gymId, f.linkId, session.id)).toBe(true);
      await done();
    });
    it('refuses a legacy setup from another household and a paid session tagged to another link', async () => {
      const f = await fixture('update_card', stripe), done = stripe ? await tapeFor(f, 'legacy-isolation') : async () => {};
      const legacy = await f.provider.createCheckout({ mode: 'setup', customerId: f.household.stripeCustomerId!,
        saveForOffSession: true, successUrl: origin, cancelUrl: origin, idempotencyKey: 'legacy' });
      const session = await f.finish(legacy.id);
      await f.dispatch(await f.deliver(session));
      const otherHousehold = await factory('households', f.gymId, { stripeCustomerId: 'cus_other' });
      const other = await f.links.create(f.context, { purpose: 'update_card', householdId: otherHousehold.id, expiresAt: f.created.link.expiresAt });
      expect(await f.checkout.complete(f.gymId, other.link.id, session.id)).toBe(false);
      const tagged = await f.checkout.start(f.gymId, f.linkId), complete = await f.finish(tagged.session.id);
      await f.dispatch(await f.deliver(complete));
      const second = await f.links.create(f.context, { purpose: 'update_card', householdId: f.household.id, expiresAt: f.created.link.expiresAt });
      expect(await f.checkout.complete(f.gymId, second.link.id, complete.id)).toBe(false);
      await done();
    });
    it('accepts an intent before Checkout completes, then completes exactly once and replays both', async () => {
      const f = await fixture('pay_invoice', stripe), done = stripe ? await tapeFor(f, 'intent-before-checkout') : async () => {};
      const opened = await f.checkout.start(f.gymId, f.linkId), session = await f.finish(opened.session.id);
      let sessionComplete = false;
      if (stripe && f.transport.objects.has(session.id)) f.transport.objects.get(session.id)!.status = 'open';
      if (!stripe) {
        const read = f.fake.readPaymentObject.bind(f.fake);
        vi.spyOn(f.fake, 'readPaymentObject').mockImplementation(async reference => {
          const result = await read(reference);
          if (!sessionComplete && result.status === 'found' && result.value.kind === 'checkout')
            result.value.object = { ...result.value.object, status: 'open' };
          return result;
        });
      }
      const intent = await f.deliver(session, 'payment_intent.succeeded');
      await f.dispatch(intent);
      expect(await f.used()).toHaveLength(0);
      expect(f.callback).not.toHaveBeenCalled();
      expect(await f.health()).toMatchObject({ pendingCount: 0, failedCount: 0 });
      sessionComplete = true;
      if (stripe && f.transport.objects.has(session.id)) f.transport.objects.get(session.id)!.status = 'complete';
      const checkout = await f.deliver(session);
      await f.dispatch(checkout);
      const usedAt = (await f.links.get(f.gymId, f.linkId)).usedAt;
      expect(await f.used()).toHaveLength(1);
      await f.dispatch(intent, true); await f.dispatch(checkout, true);
      expect(await f.used()).toHaveLength(1);
      expect((await f.links.get(f.gymId, f.linkId)).usedAt).toBe(usedAt);
      expect(await f.health()).toMatchObject({ pendingCount: 0, failedCount: 0 });
      await done();
    });
    it.each(['association', 'gym', 'link'] as const)('still fails an early intent with a mismatched %s', async mismatch => {
      const f = await fixture('pay_invoice', stripe), done = stripe ? await tapeFor(f, 'intent-mismatch-' + mismatch) : async () => {};
      const opened = await f.provider.createCheckout({ mode: 'payment', customerId: f.household.stripeCustomerId!,
        invoiceId: f.invoice.id, amount: 100, currency: 'usd', saveForOffSession: false, linkId: f.linkId,
        successUrl: origin, cancelUrl: origin, idempotencyKey: 'unassociated' });
      const session = await f.finish(opened.id), otherId = '00000000-0000-7000-8000-999999999999';
      if (mismatch !== 'association') await db.forGym(f.gymId, tx => writeAudit(tx, { gymId: f.gymId, actorKind: 'system',
        action: 'billing.checkout.started', targetType: 'signed_link', targetId: f.linkId, after: { sessionId: session.id }, occurredAt: f.clock.now() }));
      if (stripe && f.transport.objects.has(session.id)) {
        const object = f.transport.objects.get(session.id)!;
        object.status = 'open'; object.metadata = { gym_id: mismatch === 'gym' ? otherId : f.gymId,
          invoice_id: f.invoice.id, link_id: mismatch === 'link' ? otherId : f.linkId };
      } else if (!stripe) {
        const read = f.fake.readPaymentObject.bind(f.fake);
        vi.spyOn(f.fake, 'readPaymentObject').mockImplementation(async reference => {
          const result = await read(reference);
          if (result.status === 'found' && result.value.kind === 'checkout') result.value.object = { ...session,
            status: 'open', metadata: { ...session.metadata, gymId: mismatch === 'gym' ? otherId : f.gymId,
              linkId: mismatch === 'link' ? otherId : f.linkId } };
          return result;
        });
      }
      await expect(f.dispatch(await f.deliver(session, 'payment_intent.succeeded'))).rejects.toThrow(/association|mismatch|unresolved/);
      expect(f.callback).not.toHaveBeenCalled(); expect(await f.used()).toHaveLength(0);
      expect(await f.health()).toMatchObject({ failedCount: 1 });
      await done();
    });
  });
});

describe('card setup recovery with real PostgreSQL', () => {
  for (const stripe of [false, true]) {
    const name = stripe ? 'Stripe' : 'fake';
    const saved = (f: Awaited<ReturnType<typeof fixture>>) => db.forGym(f.gymId, tx => tx.select().from(paymentMethods));
    it.each(['onboarding', 'update_card'] as const)(`${name} repairs a missed webhook on %s return and tolerates late delivery`, async purpose => {
      const f = await fixture(purpose, stripe);
      if (purpose === 'onboarding') await factory('waiverTemplates', f.gymId);
      const first = await f.checkout.start(f.gymId, f.linkId), session = await f.finish(first.session.id);
      expect(await saved(f)).toHaveLength(0);
      expect(await f.checkout.complete(f.gymId, f.linkId, session.id)).toBe(purpose === 'update_card');
      expect(await saved(f)).toMatchObject([{ processorId: session.paymentMethodId, isDefault: true, revokedAt: null }]);
      expect(await f.checkout.complete(f.gymId, f.linkId, session.id)).toBe(purpose === 'update_card');
      await f.dispatch(await f.deliver(session));
      expect(await saved(f)).toHaveLength(1);
      expect(await f.used()).toHaveLength(purpose === 'update_card' ? 1 : 0);
    });
    it.each(['complete', 'expired'] as const)(`${name} replaces a provider-confirmed %s setup with an open session`, async terminal => {
      const f = await fixture('onboarding', stripe), first = await f.checkout.start(f.gymId, f.linkId);
      if (terminal === 'complete') await f.finish(first.session.id);
      else expect(await f.provider.expireCheckout(first.session.id)).toEqual({ status: 'expired' });
      const next = await f.checkout.start(f.gymId, f.linkId);
      expect(next.session).toMatchObject({ status: 'open', mode: 'setup' });
      expect(next.session.id).not.toBe(first.session.id);
      expect((await f.checkout.start(f.gymId, f.linkId)).session.id).toBe(next.session.id);
      expect(await saved(f)).toHaveLength(terminal === 'complete' ? 1 : 0);
    });
    it(`${name} shares one open session across concurrent clicks`, async () => {
      const f = await fixture('onboarding', stripe);
      const starts = await Promise.all(Array.from({ length: 5 }, () => f.checkout.start(f.gymId, f.linkId)));
      expect(new Set(starts.map(s => s.session.id)).size).toBe(1);
      const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.card_setup.started')));
      expect(audits).toHaveLength(1);
    });
    it(`${name} retries a lost renewal response with the same attempt key`, async () => {
      const f = await fixture('onboarding', stripe), first = await f.checkout.start(f.gymId, f.linkId);
      await f.provider.expireCheckout(first.session.id);
      const create = f.provider.createCheckout.bind(f.provider);
      let lost: CheckoutSession | undefined;
      const spy = vi.spyOn(f.provider, 'createCheckout').mockImplementationOnce(async request => {
        lost = await create(request); throw new Error('Connection lost after creation');
      });
      await expect(f.checkout.start(f.gymId, f.linkId)).rejects.toThrow('Connection lost');
      const next = await f.checkout.start(f.gymId, f.linkId);
      expect(next.session.id).toBe(lost!.id);
      expect(spy.mock.calls[0]![0].idempotencyKey).toBe(spy.mock.calls[1]![0].idempotencyKey);
    });
    it(`${name} re-reads an expired cached creation response before exposing the URL`, async () => {
      const f = await fixture('onboarding', stripe);
      // The provider received creation but its response never reached the app's start write.
      const first = await f.provider.createCheckout({ mode: 'setup', customerId: f.household.stripeCustomerId!, linkId: f.linkId,
        successUrl: origin + '/l/return', cancelUrl: origin + '/l/return', saveForOffSession: true,
        idempotencyKey: `signed-link:${f.linkId}:setup` });
      await f.provider.expireCheckout(first.id);
      const next = await f.checkout.start(f.gymId, f.linkId);
      expect(next.session.status).toBe('open'); expect(next.session.id).not.toBe(first.id);
    });
    it(`${name} refuses unknown sessions without blindly creating another`, async () => {
      const f = await fixture('onboarding', stripe), first = await f.checkout.start(f.gymId, f.linkId);
      const read = f.provider.readPaymentObject.bind(f.provider);
      vi.spyOn(f.provider, 'readPaymentObject').mockImplementation(reference => reference.id === first.session.id
        ? Promise.resolve({ status: 'unknown', reference }) : read(reference));
      const create = vi.spyOn(f.provider, 'createCheckout');
      await expect(f.checkout.start(f.gymId, f.linkId)).rejects.toMatchObject({ code: 'unavailable' });
      expect(create).not.toHaveBeenCalled();
    });
    it(`${name} never restores a staff-revoked card during missed-event recovery`, async () => {
      const f = await fixture('onboarding', stripe), first = await f.checkout.start(f.gymId, f.linkId), session = await f.finish(first.session.id);
      await db.forGym(f.gymId, tx => tx.insert(paymentMethods).values({ gymId: f.gymId, householdId: f.household.id,
        processorId: session.paymentMethodId!, last4: '3155', isDefault: false, revokedAt: f.clock.now() }));
      expect(await f.checkout.complete(f.gymId, f.linkId, session.id)).toBe(false);
      expect((await saved(f))[0]!.revokedAt).not.toBeNull();
    });
    it.each(['setup_customer', 'setup_link', 'method_customer'] as const)(`${name} refuses a mismatched %s before saving a card`, async mismatch => {
      const f = await fixture('onboarding', stripe), first = await f.checkout.start(f.gymId, f.linkId), session = await f.finish(first.session.id);
      const read = f.provider.readPaymentObject.bind(f.provider);
      vi.spyOn(f.provider, 'readPaymentObject').mockImplementation(async reference => {
        const result = await read(reference);
        if (result.status === 'found' && result.value.kind === 'setup') {
          const object = result.value.object;
          if (mismatch === 'setup_customer') result.value.object = { ...object, customerId: 'cus_other' };
          if (mismatch === 'setup_link') result.value.object = { ...object, metadata: { ...object.metadata, linkId: uuidv7() } };
        }
        if (result.status === 'found' && result.value.kind === 'payment_method' && mismatch === 'method_customer')
          result.value.object = { ...result.value.object, customerId: 'cus_other' };
        return result;
      });
      await expect(f.checkout.complete(f.gymId, f.linkId, session.id)).rejects.toThrow();
      expect(await saved(f)).toHaveLength(0);
    });
    it(`${name} refuses recovery across gyms, households, links and unassociated sessions`, async () => {
      const f = await fixture('onboarding', stripe), first = await f.checkout.start(f.gymId, f.linkId), session = await f.finish(first.session.id);
      const otherHousehold = await factory('households', f.gymId, { stripeCustomerId: 'cus_other' });
      const sameHouseholdLink = await f.links.create(f.context, { purpose: 'onboarding', householdId: f.household.id, expiresAt: f.created.link.expiresAt });
      const otherLink = await f.links.create(f.context, { purpose: 'onboarding', householdId: otherHousehold.id, expiresAt: f.created.link.expiresAt });
      for (const link of [sameHouseholdLink, otherLink]) expect(await f.checkout.complete(f.gymId, link.link.id, session.id)).toBe(false);
      await expect(f.checkout.complete(uuidv7(), f.linkId, session.id)).rejects.toMatchObject({ code: 'not_found' });
      const unassociated = await f.provider.createCheckout({ mode: 'setup', customerId: f.household.stripeCustomerId!, linkId: f.linkId,
        successUrl: origin, cancelUrl: origin, saveForOffSession: true, idempotencyKey: 'unassociated' });
      expect(await f.checkout.complete(f.gymId, f.linkId, (await f.finish(unassociated.id)).id)).toBe(false);
      expect(await saved(f)).toHaveLength(0);
    });
    it.each(['revoked', 'expired'] as const)(`${name} refuses a %s link before recovering any card`, async state => {
      const f = await fixture('onboarding', stripe), first = await f.checkout.start(f.gymId, f.linkId), session = await f.finish(first.session.id);
      if (state === 'revoked') await f.links.revoke(f.context, f.linkId);
      else f.clock.set('2026-12-01T00:00:00Z');
      await expect(f.checkout.complete(f.gymId, f.linkId, session.id)).rejects.toMatchObject({ code: 'not_found' });
      expect(await saved(f)).toHaveLength(0);
    });
  }
});

describe('signed-link webhook completion with real PostgreSQL', () => {
  for (const stripe of [false, true]) for (const [purpose, type] of [
    ['pay_invoice', 'checkout.session.completed'], ['pay_invoice', 'payment_intent.succeeded'],
    ['update_card', 'checkout.session.completed'], ['update_card', 'setup_intent.succeeded'],
  ] as const) it(`${stripe ? 'Stripe' : 'fake'} ${purpose} completes on ${type} without browser return`, async () => {
    const f = await fixture(purpose, stripe), start = await f.checkout.start(f.gymId, f.linkId);
    const session = await f.finish(start.session.id), eventId = await f.deliver(session, type);
    expect((await f.links.get(f.gymId, f.linkId)).usedAt).toBeNull();
    await f.dispatch(eventId);
    expect(await f.used()).toHaveLength(1);
    const usedAt = (await f.links.get(f.gymId, f.linkId)).usedAt;
    expect(f.callback).toHaveBeenCalledWith(f.gymId, f.linkId, session.id);
    expect((await f.campaigns.get(f.gymId, f.campaign.id)).progress).toMatchObject({ completed: 1, pending: 0 });
    f.clock.set('2026-11-05T12:00:00Z');
    expect(await f.campaigns.remindCampaign(f.context, f.campaign.id)).toEqual({ queued: 0 });
    await f.campaigns.scan(f.gymId);
    await f.campaigns.send({ campaignId: f.campaign.id, linkId: f.linkId, occurrence: 'manual:2026-11-05' }, f.gymId);
    expect(f.email.messages).toHaveLength(0);
    await f.dispatch(eventId, true);
    expect(await f.used()).toHaveLength(1);
    expect((await f.links.get(f.gymId, f.linkId)).usedAt).toBe(usedAt);
    expect(await f.health()).toMatchObject({ pendingCount: 0, failedCount: 0 });
  });
  it.each(['pay_invoice', 'update_card'] as const)('serializes %s browser completion racing duplicate webhook dispatches', async purpose => {
    const f = await fixture(purpose), opened = await f.checkout.start(f.gymId, f.linkId), session = await f.finish(opened.session.id);
    const eventId = await f.deliver(session);
    await Promise.all([f.dispatch(eventId), f.dispatch(eventId), f.checkout.complete(f.gymId, f.linkId, session.id)]);
    expect(await f.checkout.complete(f.gymId, f.linkId, session.id)).toBe(true);
    expect(await f.used()).toHaveLength(1);
  });
  it('completes the link ID after a real campaign reminder rotates its token during Checkout', async () => {
    const f = await fixture(), opened = await f.checkout.start(f.gymId, f.linkId);
    // Once the 24-hour hold ends a slow Checkout may still be outstanding.
    f.clock.set('2026-10-29T12:00:00Z');
    await f.campaigns.remindCampaign(f.context, f.campaign.id);
    await f.campaigns.send({ campaignId: f.campaign.id, linkId: f.linkId, occurrence: 'manual:2026-10-29' }, f.gymId);
    expect(f.email.messages).toHaveLength(1);
    expect((await f.links.resolve(f.gymId, f.created.token)).status).toBe('not_found');
    const token = f.email.messages[0]!.text.match(/\/l\/([A-Za-z0-9_-]+)/)![1]!;
    expect((await f.links.resolve(f.gymId, token)).status).toBe('active');
    await f.dispatch(await f.deliver(await f.finish(opened.session.id), 'setup_intent.succeeded'));
    expect((await f.links.resolve(f.gymId, token)).status).toBe('used');
    expect(await f.used()).toHaveLength(1);
  });
  it.each(['pay_invoice', 'update_card'] as const)('refuses unrelated, unassociated, wrong-household and wrong-gym sessions for %s', async purpose => {
    const f = await fixture(purpose), opened = await f.checkout.start(f.gymId, f.linkId), session = await f.finish(opened.session.id);
    const unrelated = await f.fake.createCheckout({ mode: session.mode, customerId: session.customerId,
      amount: 100, currency: 'usd', invoiceId: f.invoice.id, successUrl: origin, cancelUrl: origin,
      saveForOffSession: true, idempotencyKey: 'unassociated', linkId: f.linkId });
    f.fake.completeCheckout(unrelated.id);
    expect(await f.checkout.complete(f.gymId, f.linkId, unrelated.id)).toBe(false);
    const other = await f.links.create(f.context, { householdId: f.household.id, expiresAt: f.created.link.expiresAt,
      ...(purpose === 'pay_invoice' ? { purpose, invoiceId: f.invoice.id } : { purpose }) });
    expect(await f.checkout.complete(f.gymId, other.link.id, session.id)).toBe(false);
    const eventId = await f.deliver(session);
    await db.forGym(f.gymId, tx => tx.update(households).set({ stripeCustomerId: 'cus_other' }).where(eq(households.id, f.household.id)));
    expect(await f.checkout.complete(f.gymId, f.linkId, session.id)).toBe(false);
    await expect(f.dispatch(eventId)).rejects.toThrow(/customer|household/);
    const gymB = uuidv7(); await factory('gyms', gymB);
    await expect(f.checkout.complete(gymB, f.linkId, session.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await f.used()).toHaveLength(0);
  });
  it('requires both metadata and the exact persisted audit association for setup webhooks', async () => {
    const f = await fixture(), opened = await f.checkout.start(f.gymId, f.linkId), session = await f.finish(opened.session.id);
    const foreignSetup = { id: 'seti_unrelated', customerId: session.customerId, status: 'succeeded' as const,
      paymentMethodId: session.paymentMethodId!, metadata: session.metadata };
    f.fake.recordSetup(foreignSetup);
    await expect(f.dispatch(await f.deliver({ ...session, setupId: foreignSetup.id }, 'setup_intent.succeeded'))).rejects.toThrow('association');
    expect(f.callback).not.toHaveBeenCalled();
    const other = await f.links.create(f.context, { purpose: 'update_card', householdId: f.household.id, expiresAt: f.created.link.expiresAt });
    f.fake.recordSetup({ ...foreignSetup, metadata: { gymId: f.gymId, linkId: other.link.id } });
    await db.forGym(f.gymId, tx => writeAudit(tx, { gymId: f.gymId, actorKind: 'system', action: 'billing.card_setup.started',
      targetType: 'signed_link', targetId: other.link.id, after: { sessionId: session.id }, occurredAt: f.clock.now() }));
    await expect(f.dispatch(await f.deliver({ ...session, setupId: foreignSetup.id }, 'setup_intent.succeeded'))).rejects.toThrow(/association|mismatch/);
    expect(await f.used()).toHaveLength(0);
    expect((await f.links.get(f.gymId, other.link.id)).usedAt).toBeNull();
  });
  it('never uses another household or gym link even when the saved card belongs to the same customer', async () => {
    const f = await fixture(), opened = await f.checkout.start(f.gymId, f.linkId), session = await f.finish(opened.session.id);
    const otherHousehold = await factory('households', f.gymId, { stripeCustomerId: 'cus_other' });
    const other = await f.links.create(f.context, { purpose: 'update_card', householdId: otherHousehold.id, expiresAt: f.created.link.expiresAt });
    expect(await f.checkout.complete(f.gymId, other.link.id, session.id)).toBe(false);
    const gymB = uuidv7(); await factory('gyms', gymB);
    const householdB = await factory('households', gymB);
    const linksB = createSignedLinksService({ scope: db.forGym, clock: f.clock });
    const linkB = await linksB.create({ gymId: gymB, actor: { kind: 'system' } }, { purpose: 'update_card', householdId: householdB.id,
      expiresAt: f.created.link.expiresAt });
    for (const linkId of [other.link.id, linkB.link.id]) {
      f.fake.recordSetup({ id: 'seti_wrong_link', customerId: session.customerId, status: 'succeeded',
        paymentMethodId: session.paymentMethodId!, metadata: { gymId: f.gymId, linkId } });
      await expect(f.dispatch(await f.deliver({ ...session, setupId: 'seti_wrong_link' }, 'setup_intent.succeeded'))).rejects.toThrow('association');
    }
    expect(f.callback).not.toHaveBeenCalled();
    for (const [gymId, linkId, service] of [[f.gymId, f.linkId, f.links], [f.gymId, other.link.id, f.links], [gymB, linkB.link.id, linksB]] as const)
      expect((await service.get(gymId, linkId)).usedAt).toBeNull();
  });
  it('refuses a Stripe setup whose metadata gym differs from dispatch', async () => {
    const f = await fixture('update_card', true), opened = await f.checkout.start(f.gymId, f.linkId), session = await f.finish(opened.session.id);
    const eventId = await f.deliver(session, 'setup_intent.succeeded');
    f.transport.objects.get(session.setupId!)!.metadata = { gym_id: uuidv7(), link_id: f.linkId };
    await expect(f.dispatch(eventId)).rejects.toThrow(/gym|unresolved/);
    expect(f.callback).not.toHaveBeenCalled();
    expect(await f.used()).toHaveLength(0);
    expect(await db.forGym(f.gymId, tx => tx.select().from(paymentMethods))).toHaveLength(0);
  });
  it('leaves unsigned onboarding pending and completes through browser return after all waivers are signed', async () => {
    const f = await fixture('onboarding'), template = await factory('waiverTemplates', f.gymId);
    const opened = await f.checkout.start(f.gymId, f.linkId), session = await f.finish(opened.session.id);
    await f.dispatch(await f.deliver(session, 'setup_intent.succeeded'));
    expect((await f.links.get(f.gymId, f.linkId)).usedAt).toBeNull();
    expect(await f.health()).toMatchObject({ pendingCount: 0, failedCount: 0 });
    const uploads = new FakeUploads(f.gymId, f.clock);
    const waivers = createWaiversService({ scope: db.forGym, clock: f.clock, uploadsFor: async () => uploads });
    const image = await waivers.uploadSignedLink(f.gymId, f.linkId, f.member.id, demoSignaturePng());
    await waivers.signSignedLink(f.gymId, f.linkId, { memberId: f.member.id, templateId: template.id, templateVersion: template.version,
      ...image, consent: true, signer: { kind: 'guardian', name: 'Payer', relationship: 'Parent' } }, { timezone: 'UTC', ipAddress: 'unknown' });
    expect(await f.checkout.complete(f.gymId, f.linkId, session.id)).toBe(true);
    expect(await f.used()).toHaveLength(1);
  });
  it.each(['revoked', 'expired'] as const)('records the card but refuses a %s link', async state => {
    const f = await fixture(), opened = await f.checkout.start(f.gymId, f.linkId), session = await f.finish(opened.session.id);
    if (state === 'revoked') await f.links.revoke(f.context, f.linkId);
    else f.clock.set(f.created.link.expiresAt);
    await f.dispatch(await f.deliver(session, 'setup_intent.succeeded'));
    expect(await f.used()).toHaveLength(0);
    expect(await db.forGym(f.gymId, tx => tx.select().from(paymentMethods))).toHaveLength(1);
    await expect(f.checkout.complete(f.gymId, f.linkId, session.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await f.health()).toMatchObject({ pendingCount: 0, failedCount: 0 });
  });
  it('awaits the callback after the card commits, keeps failures retryable, and completes on retry', async () => {
    const f = await fixture(), opened = await f.checkout.start(f.gymId, f.linkId), session = await f.finish(opened.session.id);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    f.callback.mockImplementationOnce(async () => {
      expect(await db.forGym(f.gymId, tx => tx.select().from(paymentMethods))).toHaveLength(1);
      entered(); await held; throw new Error('Completion interrupted');
    });
    const eventId = await f.deliver(session), running = f.dispatch(eventId);
    const rejected = expect(running).rejects.toThrow('Completion interrupted');
    try { await ready; expect(await f.health()).toMatchObject({ lastProcessedAt: null, pendingCount: 1 }); }
    finally { release(); }
    await rejected;
    expect(await f.health()).toMatchObject({ lastProcessedAt: null, failedCount: 1 });
    await f.dispatch(eventId);
    expect(await f.used()).toHaveLength(1);
    expect(await f.health()).toMatchObject({ pendingCount: 0, failedCount: 0 });
  });
  it.each(['payment', 'setup'] as const)('processes legacy %s Checkouts without link metadata as before', async mode => {
    const f = await fixture();
    const opened = await f.fake.createCheckout({ mode, customerId: f.household.stripeCustomerId!,
      invoiceId: f.invoice.id, amount: 100, currency: 'usd', successUrl: origin, cancelUrl: origin,
      saveForOffSession: true, idempotencyKey: 'legacy' });
    const session = await f.finish(opened.id);
    await f.dispatch(await f.deliver(session));
    expect(f.callback).not.toHaveBeenCalled();
    expect(await f.used()).toHaveLength(0);
    expect(await f.health()).toMatchObject({ pendingCount: 0, failedCount: 0 });
    if (mode === 'payment') expect((await db.forGym(f.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, f.invoice.id))))[0]!.status).toBe('paid');
  });
  it.each(['pay_invoice', 'update_card'] as const)('replays a synthetic Stripe tape through %s start, recording and completion', async purpose => {
    const f = await fixture(purpose, true), recorder = new FixtureRecorder(f.gymId);
    const location = new URL(`./signed-link-checkout.${purpose}.synthetic.json`, import.meta.url);
    const recording = process.env.RECORD_LINK_CHECKOUT_FIXTURES === '1';
    const bind = (value: string) => value.replaceAll('00000000-0000-7000-8000-000000000001', f.gymId)
      .replaceAll('00000000-0000-7000-8000-000000000002', f.invoice.id)
      .replaceAll('00000000-0000-7000-8000-000000000003', f.linkId);
    const replay = recording ? undefined : replayTransport(JSON.parse(bind(await readFile(location, 'utf8'))) as Tape, f.gymId);
    f.setProvider(new StripePayments(f.gymId, { clock: f.clock, webhookSecret: secret, transport: replay ?? recordingTransport(f.transport, recorder) }));
    const opened = await f.checkout.start(f.gymId, f.linkId);
    if (recording) f.transport.completeCheckout(opened.session.id);
    const eventId = await f.deliver(opened.session);
    await f.dispatch(eventId); await f.dispatch(eventId, true);
    expect(await f.used()).toHaveLength(1);
    if (recording) await writeFile(location, JSON.stringify({ $comment: 'SPDX-License-Identifier: AGPL-3.0-only; synthetic Stripe API exchanges, no real account', ...recorder.tape }, null, 2)
      .replaceAll(f.gymId, '00000000-0000-7000-8000-000000000001').replaceAll(f.invoice.id, '00000000-0000-7000-8000-000000000002')
      .replaceAll(f.linkId, '00000000-0000-7000-8000-000000000003') + '\n');
    else replay!.assertConsumed();
  });
});

describe('fixed return flows with real PostgreSQL', () => {
  const flow = { successPath: '/join/return', cancelPath: '/join/cancelled', lifetimeMs: 60 * 60 * 1000 };
  const saved = (f: Awaited<ReturnType<typeof fixture>>) => db.forGym(f.gymId, async tx => (await tx.select().from(invoices).where(eq(invoices.id, f.invoice.id)))[0]!);
  it('keeps pay links on /l/return, the provider default expiry and the 23-hour reservation without a flow', async () => {
    const f = await fixture('pay_invoice'), create = vi.spyOn(f.fake, 'createCheckout');
    const opened = await f.checkout.start(f.gymId, f.linkId);
    expect(create.mock.calls[0]![0]).toMatchObject({ successUrl: origin + '/l/return', cancelUrl: origin + '/l/return' });
    expect(create.mock.calls[0]![0]).not.toHaveProperty('expiresAt');
    expect((await saved(f)).checkoutExpiresAt).toEqual(new Date('2026-10-28T11:00:00Z'));
    expect(opened.expiresAt).toBe('2026-10-28T11:00:00.000Z');
  });
  it('returns to fixed same-origin pages with a short provider expiry, renews after it lapses and completes by webhook', async () => {
    const f = await fixture('pay_invoice'), create = vi.spyOn(f.fake, 'createCheckout');
    const opened = await f.checkout.start(f.gymId, f.linkId, false, flow);
    expect(create.mock.calls[0]![0]).toMatchObject({ successUrl: origin + '/join/return', cancelUrl: origin + '/join/cancelled',
      expiresAt: new Date('2026-10-27T13:00:00Z') });
    expect(opened.expiresAt).toBe('2026-10-27T13:00:00.000Z');
    expect((await f.checkout.start(f.gymId, f.linkId, false, flow)).session.id).toBe(opened.session.id);
    f.clock.set('2026-10-27T13:00:00Z');
    const renewed = await f.checkout.start(f.gymId, f.linkId, false, flow);
    expect(renewed.session.id).not.toBe(opened.session.id);
    expect(create.mock.calls.at(-1)![0]).toMatchObject({ expiresAt: new Date('2026-10-27T14:00:00Z') });
    expect(() => f.fake.completeCheckout(opened.session.id)).toThrow('expired');
    await f.dispatch(await f.deliver(f.fake.completeCheckout(renewed.session.id)));
    expect(await f.used()).toHaveLength(1);
    expect((await saved(f)).status).toBe('paid');
  });
  it('renews a reservation too short for the provider minimum and never reuses a key with other parameters', async () => {
    const lost = async () => {
      const f = await fixture('pay_invoice'), create = vi.spyOn(f.fake, 'createCheckout');
      f.fake.loseNextResponse('createCheckout');
      await expect(f.checkout.start(f.gymId, f.linkId, false, flow)).rejects.toThrow('Provider response lost');
      expect((await saved(f)).checkoutSessionId).toBeNull();
      return { f, create };
    };
    // Twenty-five minutes left: the flow renews rather than ask for an expiry under thirty minutes.
    const short = await lost();
    short.f.clock.set('2026-10-27T12:35:00Z');
    const renewed = await short.f.checkout.start(short.f.gymId, short.f.linkId, false, flow);
    expect(short.create.mock.calls.at(-1)![0]).toMatchObject({ expiresAt: new Date('2026-10-27T13:35:00Z') });
    expect(short.create.mock.calls.at(-1)![0].idempotencyKey).not.toBe(short.create.mock.calls[0]![0].idempotencyKey);
    expect(renewed.expiresAt).toBe('2026-10-27T13:35:00.000Z');
    // A pay link replaying the flow's reservation uses its own key and keeps its own parameters.
    const shared = await lost();
    shared.f.clock.set('2026-10-27T12:10:00Z');
    await shared.f.checkout.start(shared.f.gymId, shared.f.linkId);
    expect(shared.create.mock.calls[1]![0]).toMatchObject({ successUrl: origin + '/l/return' });
    expect(shared.create.mock.calls[1]![0]).not.toHaveProperty('expiresAt');
    expect(shared.create.mock.calls[1]![0].idempotencyKey).toBe(shared.create.mock.calls[0]![0].idempotencyKey.split(':/join')[0]);
  });
  it.each([
    ['an absolute success URL', { ...flow, successPath: 'https://evil.example/join' }],
    ['a protocol-relative cancel path', { ...flow, cancelPath: '//evil.example/join' }],
    ['a query string', { ...flow, successPath: '/join/return?next=https://evil.example' }],
    ['a lifetime below the provider minimum', { ...flow, lifetimeMs: 30 * 60 * 1000 }],
    ['a lifetime beyond the idempotency window', { ...flow, lifetimeMs: 24 * 60 * 60 * 1000 }],
  ])('refuses %s before reserving or calling the provider', async (_name, invalid) => {
    const f = await fixture('pay_invoice'), create = vi.spyOn(f.fake, 'createCheckout');
    await expect(f.checkout.start(f.gymId, f.linkId, false, invalid)).rejects.toMatchObject({ code: 'unavailable' });
    expect(create).not.toHaveBeenCalled();
    expect((await saved(f)).checkoutExpiresAt).toBeNull();
  });
  it('refuses a flow for card links, which have no invoice to pay', async () => {
    const f = await fixture('update_card'), create = vi.spyOn(f.fake, 'createCheckout');
    await expect(f.checkout.start(f.gymId, f.linkId, false, flow)).rejects.toMatchObject({ code: 'unavailable' });
    expect(create).not.toHaveBeenCalled();
  });
});
