// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Tests inspect jobs and edit settings in their isolated PostgreSQL database.
import { auditEvents, gyms, households, invoices, jobs, members, paymentMethods, signedLinks, smsDeliveries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import { FakeEmail, DeliveryError } from '../../../infra/email/index.js';
import { FakeJobs, PostgresJobs } from '../../../infra/jobs/index.js';
import { FakePayments } from '../../../infra/payments/index.js';
import { createSmsDeliveries, FakeSms, SmsDeliveryError, type Sms } from '../../../infra/sms/index.js';
import { takeSmsSlot } from '../../../infra/sms/daily-cap.js';
import { smsInFlightMs } from '../../../infra/sms/deliveries.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import type { SmsResolver } from '../../settings/sms.js';
import { createSignedLinksService } from '../../links/service.js';
import { createBillingAlerts } from '../alerts/index.js';
import { createCardExpirySms } from '../alerts/sms.js';
import { createPaymentJobs } from '../payments.jobs.js';
import { createMembershipService } from '../memberships.js';
import { createInvoiceTransitions } from './index.js';
import { createTransitionEffects } from './effects.js';
import { createTransitionJobs } from './transitions.jobs.js';
import { createTransitionNotifications } from './notifications.js';
import { createTransitionSmsNotifications, type BillingSmsOptions } from './notifications.sms.js';
import { effect, effectCompleted, snapshot } from './store.js';

const db = useTestDatabase(), make = createFactories(db), scope = db.forGym;
const phone = '+12025550123', fallback = '+12025550199', origin = 'https://gym.example.invalid';
async function fixture(changes: { enabled?: boolean; amountCents?: number; currency?: string } = {}) {
  const gymId = uuidv7(), clock = new TestClock('2026-11-16T12:00:00Z');
  await make('gyms', gymId, { name: 'Test Gym', address: { country: 'US' }, timezone: 'UTC', currency: changes.currency ?? 'USD',
    memberSmsEnabled: changes.enabled ?? true, memberEmailsEnabled: true });
  const consent = { smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'portal' };
  const home = await make('households', gymId, { email: 'payer@example.invalid', phone, phoneE164: phone, ...consent });
  const children = await Promise.all([1, 2, 3].map(() => make('members', gymId, { householdId: home.id })));
  const invoice = await make('invoices', gymId, { householdId: home.id, number: 7, status: 'past_due',
    amountCents: changes.amountCents ?? 10000, currency: changes.currency ?? 'USD' });
  const card = await make('paymentMethods', gymId, { householdId: home.id, isDefault: true, expiryMonth: 11, expiryYear: 2026 });
  await make('memberships', gymId, { householdId: home.id, memberId: children[0]!.id, status: 'active',
    startsOn: '2026-01-01', nextDueOn: '2026-12-01', amountCents: 10000, currency: changes.currency ?? 'USD' });
  const text = new FakeSms(), email = new FakeEmail(), holder: { sms: Sms } = { sms: text };
  const resolver: SmsResolver = { async resolve(id) { return { gymId: id, name: 'Test Gym', sms: holder.sms }; },
    async configured() { return true; }, async status() { return { source: 'gym', unreadable: false }; } };
  const settings = createGymSettingsAccessor({ scope });
  const options: BillingSmsOptions = { scope, clock, settings, resolver, prepare: async () => ({ origin }) };
  const notice = { gymId, generation: uuidv7(), invoice: snapshot(invoice) };
  const rows = () => scope(gymId, tx => tx.select().from(smsDeliveries));
  const links = () => scope(gymId, tx => tx.select().from(signedLinks));
  const context = () => ({ gymId, timezone: 'UTC', clock, jobId: uuidv7(), attempt: 1 });
  return { gymId, clock, consent, home, children, invoice, card, text, holder, email, options, notice, rows, links, context };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function exhaustCap(f: Fixture) {
  await scope(f.gymId, async tx => {
    await tx.update(gyms).set({ smsDailyCap: 1 }).where(eq(gyms.id, f.gymId));
    expect(await takeSmsSlot(tx, f.gymId, f.clock.now(), 'UTC', 1)).toBe(true);
  });
}
const senders = [
  { name: 'receipt', count: 0, send: (f: Fixture, options = f.options) => createTransitionSmsNotifications(options).receipt(f.notice) },
  { name: 'failed payment', count: 2, send: (f: Fixture, options = f.options) => createTransitionSmsNotifications(options).dunning({ ...f.notice, actionRequired: false }) },
  { name: 'authentication', count: 2, send: (f: Fixture, options = f.options) => createTransitionSmsNotifications(options).dunning({ ...f.notice, actionRequired: true }) },
  { name: 'card expiry', count: 1, send: (f: Fixture, options = f.options) => createCardExpirySms(options).send(f.gymId, f.card.id, '2026-12-01') },
];

it.each(['insufficient_funds', 'payment_method_unusable'] as const)('texts the bank failure and recovery link for %s', async bankCode => {
  const f = await fixture();
  await createTransitionSmsNotifications(f.options).dunning({ ...f.notice, actionRequired: false, bankCode });
  const body = f.text.messages[0]!.body;
  expect(body).toContain("didn't go through");
  expect(body).toContain(bankCode === 'insufficient_funds' ? 'Pay the invoice' : 'Add a new payment method');
  expect(body).toContain('/l/');
});

describe.each(senders)('$name SMS with real Postgres and RLS', sender => {
  it('texts a billing parent with no member record once for three children across concurrent retries and restart', async () => {
    const f = await fixture();
    await Promise.allSettled([sender.send(f), sender.send(f)]);
    await sender.send(f);
    expect(f.text.messages).toHaveLength(1);
    expect(f.text.messages[0]).toMatchObject({ to: phone });
    expect(f.text.messages[0]!.body).toMatch(/^Test Gym: /);
    expect(await f.links()).toHaveLength(sender.count);
    expect(await f.rows()).toMatchObject([{ state: 'accepted', attempts: 1 }]);
    expect(JSON.stringify(await f.rows())).not.toContain(phone);
    const service = createSignedLinksService({ scope, clock: f.clock }), other = await fixture();
    for (const match of f.text.messages[0]!.body.matchAll(/\/l\/([\w-]+)/g)) {
      expect(await service.resolve(f.gymId, match[1]!)).toMatchObject({ status: 'active', principal: { householdId: f.home.id } });
      expect(await service.resolve(other.gymId, match[1]!)).toEqual({ status: 'not_found' });
      expect(JSON.stringify(await f.rows())).not.toContain(match[1]!);
      expect(JSON.stringify(await f.links())).not.toContain(match[1]!);
    }
  });
  it('keeps an unknown send and its links, never resending even if the transport later becomes ready', async () => {
    const f = await fixture(), send = f.text.sendSms.bind(f.text);
    f.holder.sms = { async verifyAccount() {}, async sendSms(message) { await send(message); throw new SmsDeliveryError('unknown'); } };
    await expect(sender.send(f)).rejects.toThrow();
    f.holder.sms = f.text;
    await sender.send(f);
    expect(f.text.messages).toHaveLength(1);
    expect(await f.rows()).toMatchObject([{ state: 'unknown' }]);
    expect(await f.links()).toHaveLength(sender.count);
    expect((await f.links()).every(link => link.revokedAt === null)).toBe(true);
  });
  it('revokes a definitely refused link and retries with fresh links only', async () => {
    const f = await fixture();
    f.text.respondNext(new SmsDeliveryError('not_accepted'));
    await expect(sender.send(f)).rejects.toThrow();
    expect(await f.links()).toHaveLength(sender.count);
    expect((await f.links()).every(link => link.revokedAt !== null)).toBe(true);
    await sender.send(f); await sender.send(f);
    expect(f.text.messages).toHaveLength(1);
    expect((await f.links()).filter(link => !link.revokedAt)).toHaveLength(sender.count);
    expect(await f.rows()).toMatchObject([{ state: 'accepted', attempts: 2 }]);
  });
  it('revokes links after a suppressed provider send and leaves the key retryable', async () => {
    const f = await fixture();
    f.text.respondNext({ status: 'suppressed', reason: 'disabled' });
    await sender.send(f);
    expect(f.text.messages).toEqual([]);
    expect(await f.links()).toHaveLength(sender.count);
    expect((await f.links()).every(link => link.revokedAt !== null)).toBe(true);
    await sender.send(f);
    expect(f.text.messages).toHaveLength(1);
  });
  it.each(['cap_reached', 'no_provider'] as const)('drops %s permanently, including retries after midnight or provider recovery', async reason => {
    const f = await fixture();
    if (reason === 'cap_reached') await exhaustCap(f);
    const resolve = vi.spyOn(f.options.resolver, 'resolve');
    if (reason === 'no_provider') resolve.mockResolvedValueOnce(null);
    await expect(sender.send(f)).resolves.toBeUndefined();
    expect(f.text.messages).toEqual([]);
    expect(await f.rows()).toMatchObject([{ state: 'not_accepted', attempts: 1, commandResult: { suppression: reason } }]);
    expect((await f.links()).every(link => link.revokedAt !== null)).toBe(true);
    f.clock.advance(24 * 3600_000);
    await scope(f.gymId, tx => tx.update(gyms).set({ smsDailyCap: 100 }).where(eq(gyms.id, f.gymId)));
    await sender.send(f);
    expect(f.text.messages).toEqual([]);
    expect(await f.links()).toHaveLength(sender.count);
    expect(await f.rows()).toMatchObject([{ attempts: 1, commandResult: { suppression: reason } }]);
  });
  it('never resends after acceptance when all outcome writes fail', async () => {
    const f = await fixture(), send = f.text.sendSms.bind(f.text);
    let failed = false;
    f.holder.sms = { async verifyAccount() {}, async sendSms(message) { const result = await send(message); failed = true; return result; } };
    const options = { ...f.options, scope: (async (gymId, fn) => scope(gymId, async tx => {
      const result = await fn(tx);
      if (failed) throw new Error('Outcome write lost');
      return result;
    })) as typeof scope };
    await expect(sender.send(f, options)).rejects.toThrow();
    f.clock.advance(61_000);
    await sender.send(f);
    expect(f.text.messages).toHaveLength(1);
    expect(await f.links()).toHaveLength(sender.count);
    expect((await f.links()).every(link => link.revokedAt === null)).toBe(true);
  });
  it('keeps a crash after reservation commit uncertain and mints nothing again', async () => {
    const f = await fixture();
    let crash = true;
    const options = { ...f.options, scope: (async (gymId, fn) => {
      const result = await scope(gymId, fn);
      if (crash && (await f.rows()).length) { crash = false; throw new Error('Worker crashed after commit'); }
      return result;
    }) as typeof scope };
    await expect(sender.send(f, options)).rejects.toThrow('Worker crashed after commit');
    f.clock.advance(61_000);
    await sender.send(f);
    expect(f.text.messages).toHaveLength(0);
    expect(await f.links()).toHaveLength(sender.count);
    expect((await f.links()).every(link => link.revokedAt === null)).toBe(true);
    expect(await f.rows()).toMatchObject([{ attempts: 1 }]);
  });
  it('rolls reservation and links back together before a commit', async () => {
    const f = await fixture();
    const options = { ...f.options, scope: (async (gymId, fn) => scope(gymId, async tx => {
      const result = await fn(tx);
      if ((await tx.select().from(smsDeliveries)).length) throw new Error('Before commit');
      return result;
    })) as typeof scope };
    await expect(sender.send(f, options)).rejects.toThrow('Before commit');
    expect(await f.rows()).toEqual([]); expect(await f.links()).toEqual([]);
    await sender.send(f);
    expect(f.text.messages).toHaveLength(1);
  });
  it('uses only notices-consented members at the billing email when the billing phone has no consent', async () => {
    const f = await fixture();
    await scope(f.gymId, async tx => {
      await tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id));
      await tx.update(members).set({ ...f.consent, email: ' PAYER@example.invalid ', phone: fallback, phoneE164: fallback }).where(eq(members.id, f.children[0]!.id));
      await tx.update(members).set({ ...f.consent, email: 'other@example.invalid', phone: '+12025550188', phoneE164: '+12025550188' }).where(eq(members.id, f.children[1]!.id));
    });
    await sender.send(f); await sender.send(f);
    expect(f.text.messages.map(message => message.to)).toEqual([fallback]);
  });
  it('prefers the consented billing phone over a consented member at its email', async () => {
    const f = await fixture();
    await scope(f.gymId, tx => tx.update(members).set({ ...f.consent, email: f.home.email, phone: fallback, phoneE164: fallback }).where(eq(members.id, f.children[0]!.id)));
    await sender.send(f);
    expect(f.text.messages.map(message => message.to)).toEqual([phone]);
  });
  it('sends nothing with neither notices consent nor the member SMS switch', async () => {
    const f = await fixture();
    await scope(f.gymId, tx => tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id)));
    await scope(f.gymId, tx => tx.update(members).set({ smsAnnouncementsConsentAt: f.clock.now(), smsAnnouncementsConsentSource: 'portal', email: f.home.email, phone: fallback, phoneE164: fallback }).where(eq(members.id, f.children[0]!.id)));
    await sender.send(f);
    const off = await fixture({ enabled: false }); await sender.send(off);
    expect(f.text.messages).toEqual([]); expect(off.text.messages).toEqual([]);
    expect(await f.rows()).toEqual([]); expect(await off.rows()).toEqual([]);
    expect(await f.links()).toEqual([]); expect(await off.links()).toEqual([]);
  });
  it('revokes its links if consent is withdrawn during preparation', async () => {
    const f = await fixture();
    await sender.send(f, { ...f.options, prepare: async () => {
      await scope(f.gymId, tx => tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id)));
      return { origin };
    } });
    expect(f.text.messages).toEqual([]);
    expect(await f.links()).toHaveLength(sender.count);
    expect((await f.links()).every(link => link.revokedAt !== null)).toBe(true);
    expect(await f.rows()).toMatchObject([{ state: 'not_accepted' }]);
  });
  it('does not use another household with the same billing email or another gym', async () => {
    const f = await fixture(), other = await fixture();
    const home = await make('households', f.gymId, { email: f.home.email });
    await make('members', f.gymId, { householdId: home.id, email: f.home.email, phone: fallback, phoneE164: fallback, ...f.consent });
    await scope(f.gymId, tx => tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id)));
    await sender.send(f);
    expect(f.text.messages).toEqual([]);
    if (sender.name === 'card expiry') await createCardExpirySms(f.options).send(f.gymId, other.card.id, '2026-12-01');
    else {
      const sms = createTransitionSmsNotifications(f.options);
      await sms.receipt({ ...other.notice, gymId: f.gymId });
      await sms.dunning({ ...f.notice, invoice: { ...f.notice.invoice, householdId: home.id }, actionRequired: false });
    }
    expect(f.text.messages).toEqual([]); expect(other.text.messages).toEqual([]);
    expect(await f.links()).toEqual([]); expect(await other.links()).toEqual([]);
  });
});

it('uses separate keys and credentials for email and text, and staff receipt resends remain email only', async () => {
  const f = await fixture(), sms = createTransitionSmsNotifications(f.options);
  const notifications = createTransitionNotifications({ ...f.options, sms,
    prepare: async () => ({ email: f.email, origin }), staffRecipients: async () => [] });
  await notifications.dunning({ ...f.notice, actionRequired: false });
  await notifications.dunning({ ...f.notice, actionRequired: true });
  expect(f.email.messages).toHaveLength(1); expect(f.text.messages).toHaveLength(1);
  const emailTokens = [...f.email.messages[0]!.text.matchAll(/\/l\/([\w-]+)/g)].map(match => match[1]);
  for (const token of emailTokens) expect(f.text.messages[0]!.body).not.toContain(token);
  expect(await f.links()).toHaveLength(4);
  await scope(f.gymId, tx => tx.update(invoices).set({ status: 'paid', paidAt: f.clock.now() }).where(eq(invoices.id, f.invoice.id)));
  const job = createPaymentJobs({ scope, notifications, detachCard: async () => {} })[0]!;
  await job.handler({ invoiceId: f.invoice.id }, f.context());
  expect(f.email.messages).toHaveLength(2); expect(f.text.messages).toHaveLength(1);
});

it('sends SMS independently when email fails, and retries only the channel that did not send', async () => {
  const f = await fixture();
  const notifications = createTransitionNotifications({ ...f.options, sms: createTransitionSmsNotifications(f.options), staffRecipients: async () => [],
    prepare: async () => ({ email: f.email, origin }) });
  f.email.respondNext(new DeliveryError('not_accepted', 'SMTP refused'));
  await expect(notifications.receipt(f.notice)).rejects.toThrow('SMTP refused');
  await notifications.receipt(f.notice);
  expect(f.email.messages).toHaveLength(1); expect(f.text.messages).toHaveLength(1);
  expect(f.text.messages[0]!.body).toContain('$100.00');
});

it.each([{ amountCents: 32, currency: 'CAD' }, { amountCents: 10001, currency: 'HUF' }])('sends manual-payment guidance without card links for an unchargeable amount %j', async changes => {
  const f = await fixture(changes);
  await createTransitionSmsNotifications(f.options).dunning({ ...f.notice, actionRequired: false });
  expect(f.text.messages[0]!.body).toContain('Contact the gym to arrange a manual payment');
  expect(await f.links()).toEqual([]);
});

it('revokes its links and releases a notice when its origin is invalid', async () => {
  const f = await fixture();
  await expect(senders[1]!.send(f, { ...f.options, prepare: async () => ({ origin: origin + '/untrusted' }) })).rejects.toThrow('Invalid billing notification origin');
  expect(f.text.messages).toEqual([]); expect((await f.links()).every(link => link.revokedAt !== null)).toBe(true);
});

async function useFallbackPhones(f: Fixture) {
  await scope(f.gymId, async tx => {
    await tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id));
    for (const [i, to] of [phone, fallback].entries()) await tx.update(members).set({ ...f.consent,
      email: f.home.email, phone: to, phoneE164: to }).where(eq(members.id, f.children[i]!.id));
  });
}

it('reserves each distinct fallback phone under its consent-holder ID, even for the same three children', async () => {
  const f = await fixture();
  await useFallbackPhones(f);
  await senders[1]!.send(f); await senders[1]!.send(f);
  expect(f.text.messages.map(message => message.to).sort()).toEqual([phone, fallback].sort());
  expect(await f.rows()).toHaveLength(2); expect(await f.links()).toHaveLength(4);
});

it('sends the later recipient once on retry after a crash at the first reservation', async () => {
  const f = await fixture();
  await useFallbackPhones(f);
  const sender = senders[1]!;
  const crashAfterReservation: typeof scope = async (gymId, fn) => {
    const result = await scope(gymId, fn);
    if ((await f.rows()).length) throw new Error('Worker crashed after commit');
    return result;
  };
  await expect(sender.send(f, { ...f.options, scope: crashAfterReservation })).rejects.toThrow('Worker crashed after commit');
  expect(await f.rows()).toMatchObject([{ state: 'sending', attempts: 1 }]);
  expect(await f.links()).toHaveLength(2);
  expect(f.text.messages).toEqual([]);

  f.clock.advance(smsInFlightMs + 1);
  await sender.send(f);
  await sender.send(f);
  expect(f.text.messages.map(message => message.to)).toEqual([fallback]);
  expect(await f.links()).toHaveLength(4);
  expect((await f.rows()).map(row => [row.state, row.attempts]).sort()).toEqual([['accepted', 1], ['sending', 1]]);
});

it('skips an in-flight reservation, sends the other recipient once, and retries until the first one settles', async () => {
  const f = await fixture();
  await useFallbackPhones(f);
  const deliveries = createSmsDeliveries({ scope, clock: f.clock });
  const key = `billing.sms.dunning:${f.invoice.id}:${f.notice.generation}:${f.children[0]!.id}`;
  const reservation = await scope(f.gymId, tx => deliveries.reserve(tx, f.gymId, key));

  // The other attempt is still in flight, so the effect fails and is retried, but the other recipient is not held up.
  await expect(senders[1]!.send(f)).rejects.toThrow('This sms is still being sent');
  await expect(senders[1]!.send(f)).rejects.toThrow('This sms is still being sent');
  expect(await deliveries.state(f.gymId, key)).toBe('sending');
  expect(f.text.messages.map(message => message.to)).toEqual([fallback]);
  expect(await f.links()).toHaveLength(2);
  expect((await f.rows()).map(row => [row.state, row.attempts]).sort()).toEqual([['accepted', 1], ['sending', 1]]);

  // That attempt ends in a definite non-send: the retry texts its recipient once, and the other recipient stays at one text.
  await deliveries.release(reservation!);
  await senders[1]!.send(f);
  await senders[1]!.send(f);
  expect(f.text.messages.map(message => message.to)).toEqual([fallback, phone]);
  expect(await f.links()).toHaveLength(4);
  expect((await f.rows()).map(row => [row.state, row.attempts]).sort()).toEqual([['accepted', 1], ['accepted', 2]]);
});

it('queues and sends a card text without SMTP readiness or a deliverable household email', async () => {
  const f = await fixture(), queue = new FakeJobs(), prepare = vi.fn(async () => { throw new Error('No SMTP'); });
  await scope(f.gymId, tx => tx.update(households).set({ email: null }).where(eq(households.id, f.home.id)));
  const settings = { get: async (id: string) => ({ ...await f.options.settings.get(id), memberEmailsEnabled: false }) };
  const options = { ...f.options, settings };
  const alerts = createBillingAlerts({ ...options, jobs: queue, accounts: { staffEmails: async () => [] },
    sms: createCardExpirySms(options), prepare });
  await alerts.cardExpiry(f.gymId);
  expect(queue.jobs).toHaveLength(1);
  await alerts.sendSms(queue.jobs[0]!.payload, f.context());
  await alerts.sendSms(queue.jobs[0]!.payload, f.context());
  expect(prepare).not.toHaveBeenCalled(); expect(f.text.messages).toHaveLength(1);
  expect(await f.links()).toHaveLength(1);
});

it('rechecks the default card after preparation and revokes a never-sent link', async () => {
  const f = await fixture();
  await senders[3]!.send(f, { ...f.options, prepare: async () => {
    await scope(f.gymId, tx => tx.update(paymentMethods).set({ isDefault: false }).where(eq(paymentMethods.id, f.card.id)));
    return { origin };
  } });
  expect(f.text.messages).toEqual([]); expect(await f.links()).toMatchObject([{ revokedAt: f.clock.now() }]);
});

it('keys the billing phone by household, so erasing a covered child before a retry never texts again', async () => {
  const f = await fixture(), anonymize = (id: string) => scope(f.gymId, tx => tx.update(members)
    .set({ anonymizedAt: f.clock.now() }).where(eq(members.id, id)));
  await senders[1]!.send(f);
  await anonymize(f.children.map(child => child.id).sort()[0]!);
  await senders[1]!.send(f);
  expect(f.text.messages).toHaveLength(1); expect(await f.rows()).toHaveLength(1);
});

it('still texts the billing phone when a covered child is erased during preparation', async () => {
  const f = await fixture();
  await senders[1]!.send(f, { ...f.options, prepare: async () => {
    await scope(f.gymId, tx => tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, f.children[2]!.id)));
    return { origin };
  } });
  expect(f.text.messages).toHaveLength(1); expect(await f.rows()).toMatchObject([{ state: 'accepted' }]);
});

it('repairs revocation lost after a definite non-send before minting fresh credentials', async () => {
  const f = await fixture();
  f.text.respondNext(new SmsDeliveryError('not_accepted'));
  const options = { ...f.options, scope: (async (gymId, fn) => scope(gymId, async tx => {
    const result = await fn(tx);
    if ((await tx.select().from(signedLinks)).some(link => link.revokedAt !== null)) throw new Error('Revoke failed');
    return result;
  })) as typeof scope };
  const error = await senders[1]!.send(f, options).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors[0]).toBeInstanceOf(SmsDeliveryError);
  expect((error as AggregateError).errors[0]).toMatchObject({ acceptance: 'not_accepted' });
  expect((error as AggregateError).errors[1]).toMatchObject({ message: 'Billing SMS cleanup failed', errors: [expect.objectContaining({ message: 'Revoke failed' })] });
  expect(await f.rows()).toMatchObject([{ state: 'not_accepted' }]);
  expect(await f.links()).toMatchObject([{ revokedAt: null }, { revokedAt: null }]);
  await senders[1]!.send(f);
  expect((await f.links()).filter(link => !link.revokedAt)).toHaveLength(2);
  expect((await f.links()).filter(link => link.revokedAt)).toHaveLength(2);
  expect(f.text.messages).toHaveLength(1);
});

it('keeps an invalid-origin error together with both cleanup failures', async () => {
  const f = await fixture();
  let failCleanup = false;
  const options = { ...f.options, prepare: async () => { failCleanup = true; return { origin: origin + '/invalid' }; },
    scope: (async (gymId, fn) => {
      if (failCleanup) throw new Error('Cleanup unavailable');
      return scope(gymId, fn);
    }) as typeof scope };
  const error = await senders[1]!.send(f, options).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors[0]).toMatchObject({ message: 'Invalid billing notification origin' });
  expect((error as AggregateError).errors[1].errors).toHaveLength(2);
  expect(f.text.messages).toEqual([]);
});

it.each(['cap_reached', 'no_provider'] as const)('completes a real queued receipt effect after %s with no recovery or next-day send', async reason => {
  const f = await fixture(), queue = new PostgresJobs({ database: db, clock: f.clock });
  if (reason === 'cap_reached') await exhaustCap(f);
  else vi.spyOn(f.options.resolver, 'resolve').mockResolvedValueOnce(null);
  const notifications = createTransitionNotifications({ ...f.options, sms: createTransitionSmsNotifications(f.options),
    prepare: async () => ({ email: f.email, origin }), staffRecipients: async () => [] });
  const effects = createTransitionEffects({ ...f.options, jobs: queue, recovery: queue, notifications,
    transitions: createInvoiceTransitions(f.options), memberships: createMembershipService(f.options),
    payments: async () => new FakePayments(f.gymId, f.clock), retry: async () => {} });
  for (const job of createTransitionJobs(() => effects)) queue.handle(job.id, job.handler);
  await scope(f.gymId, tx => effect(tx, { gymId: f.gymId, actor: { kind: 'system' } }, f.clock, { kind: 'receipt', invoiceId: f.invoice.id }));
  await effects.publish(f.gymId);
  expect(await queue.runNext()).toBe(true);
  expect(await queue.runNext()).toBe(false);
  expect(await scope(f.gymId, tx => tx.select().from(jobs))).toMatchObject([{ status: 'succeeded', attempts: 1 }]);
  expect(await scope(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, effectCompleted)))).toHaveLength(1);
  expect(await f.rows()).toMatchObject([{ commandResult: { suppression: reason } }]);
  expect(f.email.messages).toHaveLength(1); expect(f.text.messages).toEqual([]);
  f.clock.advance(24 * 3600_000);
  expect(await effects.recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
  await effects.publish(f.gymId);
  expect(await queue.runNext()).toBe(false);
  expect(f.text.messages).toEqual([]);
});

it('does not revive a capped text when a failed email retries the enclosing notice after midnight', async () => {
  const f = await fixture();
  await exhaustCap(f);
  const notifications = createTransitionNotifications({ ...f.options, sms: createTransitionSmsNotifications(f.options),
    prepare: async () => ({ email: f.email, origin }), staffRecipients: async () => [] });
  f.email.respondNext(new DeliveryError('not_accepted', 'SMTP refused'));
  await expect(notifications.receipt(f.notice)).rejects.toThrow('SMTP refused');
  await scope(f.gymId, tx => tx.update(gyms).set({ smsDailyCap: 100 }).where(eq(gyms.id, f.gymId)));
  f.clock.advance(24 * 3600_000);
  await notifications.receipt(f.notice);
  expect(f.email.messages).toHaveLength(1); expect(f.text.messages).toEqual([]);
  expect(await f.rows()).toMatchObject([{ attempts: 1, commandResult: { suppression: 'cap_reached' } }]);
});

it('repairs suppressed-text cleanup without reserving again or sending after provider recovery', async () => {
  const f = await fixture();
  vi.spyOn(f.options.resolver, 'resolve').mockResolvedValueOnce(null);
  const options = { ...f.options, scope: (async (gymId, fn) => scope(gymId, async tx => {
    const result = await fn(tx);
    if ((await tx.select().from(signedLinks)).some(link => link.revokedAt !== null)) throw new Error('Revoke failed');
    return result;
  })) as typeof scope };
  await expect(senders[1]!.send(f, options)).rejects.toThrow('Billing SMS cleanup failed');
  expect(await f.rows()).toMatchObject([{ attempts: 1, commandResult: { suppression: 'no_provider' } }]);
  expect((await f.links()).every(link => link.revokedAt === null)).toBe(true);
  await senders[1]!.send(f);
  expect(f.text.messages).toEqual([]);
  expect((await f.links()).every(link => link.revokedAt !== null)).toBe(true);
  expect(await f.rows()).toMatchObject([{ attempts: 1 }]);
});
