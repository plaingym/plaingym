// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { emailDeliveries, households, invoices, signedLinks, uuidv7 } from '@plaingym/db';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '../../../../../../packages/db/src/testing/database.js';
import { createFactories } from '../../../../../../packages/db/src/testing/factories.js';
import { TestClock } from '../../../core/clock.js';
import { DeliveryError, FakeEmail, recipientDigest, type Email, type EmailMessage } from '../../../infra/email/index.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createPaymentJobs } from '../payments.jobs.js';
import { snapshot } from './store.js';
import { createTransitionNotifications, type TransitionNotifications } from './notifications.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(staff = ['owner@example.invalid'], amountCents = 10000, currency = 'USD') {
  const gymId = uuidv7(), clock = new TestClock('2026-11-06T12:00:00Z'), fake = new FakeEmail();
  await factory('gyms', gymId, { memberEmailsEnabled: true, currency });
  const household = await factory('households', gymId, { email: 'payer@example.invalid' });
  await factory('members', gymId, { householdId: household.id, email: 'payer@example.invalid' });
  const invoice = await factory('invoices', gymId, { householdId: household.id, amountCents, currency, status: 'open', number: 7 });
  const holder: { email: Email } = { email: fake };
  const notifications = createTransitionNotifications({ scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }),
    prepare: async () => ({ email: holder.email, origin: 'https://gym.example.invalid' }), staffRecipients: async () => staff });
  const notice = async (generation: string) => {
    const [row] = await db.forGym(gymId, tx => tx.select().from(invoices).where(eq(invoices.id, invoice.id)));
    return { gymId, generation, invoice: snapshot(row!) };
  };
  const links = () => db.forGym(gymId, tx => tx.select().from(signedLinks));
  return { gymId, clock, fake, holder, household, invoice, notifications, notice, links };
}
type Notice = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['notice']>>;
const refund = { id: uuidv7(), amountCents: 2500 } as never;
const senders: [string, number, (notifications: TransitionNotifications, notice: Notice) => Promise<void>][] = [
  ['receipt', 0, (n, notice) => n.receipt(notice)],
  ['failed-payment dunning', 2, (n, notice) => n.dunning({ ...notice, actionRequired: false })],
  ['action-required dunning', 2, (n, notice) => n.dunning({ ...notice, actionRequired: true })],
  ['duplicate payment staff notice', 0, (n, notice) => n.staffNotice(notice)],
  ['canceled refund staff notice', 0, (n, notice) => n.staffNotice({ ...notice, reason: 'refund_canceled', refund })],
  ['failed refund staff notice', 0, (n, notice) => n.staffNotice({ ...notice, reason: 'refund_failed', refund })],
  ['reversed refund staff notice', 0, (n, notice) => n.staffNotice({ ...notice, reason: 'refund_failed', refund, reversed: true })],
];

describe('keyed billing notices', () => {
  it.each(senders)('%s: a repeated job sends once and mints nothing more; new work sends again', async (_name, minted, send) => {
    const f = await fixture(), generation = uuidv7();
    await send(f.notifications, await f.notice(generation));
    await send(f.notifications, await f.notice(generation));
    expect(f.fake.messages).toHaveLength(1);
    expect(await f.links()).toHaveLength(minted);
    await send(f.notifications, await f.notice(uuidv7()));
    expect(f.fake.messages).toHaveLength(2);
    expect(await f.links()).toHaveLength(minted * 2);
  });
  it('one failed charge gets one notice even if its attempt turns action-required between retries', async () => {
    const f = await fixture(), notice = await f.notice(uuidv7());
    await f.notifications.dunning({ ...notice, actionRequired: false });
    await f.notifications.dunning({ ...notice, actionRequired: true });
    expect(f.fake.messages).toHaveLength(1);
  });
  it.each(senders)('%s: skips preparation after every recipient has already been accepted', async (_name, _minted, send) => {
    const staff = ['first@example.invalid', 'second@example.invalid'], f = await fixture(staff), notice = await f.notice(uuidv7());
    await send(f.notifications, notice);
    let preparations = 0;
    const retried = createTransitionNotifications({ scope: db.forGym, clock: f.clock,
      settings: createGymSettingsAccessor({ scope: db.forGym }), staffRecipients: async () => staff,
      prepare: async () => { preparations++; throw new Error('SMTP settings removed'); } });
    await send(retried, notice);
    expect(preparations).toBe(0);
  });
  it('prepares once for multiple reserved staff recipients', async () => {
    const f = await fixture(), notice = await f.notice(uuidv7());
    let preparations = 0;
    const notifications = createTransitionNotifications({ scope: db.forGym, clock: f.clock,
      settings: createGymSettingsAccessor({ scope: db.forGym }), staffRecipients: async () => ['first@example.invalid', 'second@example.invalid'],
      prepare: async () => { preparations++; return { email: f.fake, origin: 'https://gym.example.invalid' }; } });
    await notifications.staffNotice(notice);
    expect(preparations).toBe(1);
    expect(f.fake.messages).toHaveLength(2);
  });
  it('releases all reserved staff recipients after one shared preparation failure', async () => {
    const f = await fixture(), notice = await f.notice(uuidv7());
    let preparations = 0;
    const notifications = createTransitionNotifications({ scope: db.forGym, clock: f.clock,
      settings: createGymSettingsAccessor({ scope: db.forGym }), staffRecipients: async () => ['first@example.invalid', 'second@example.invalid'],
      prepare: async () => { preparations++; throw new Error('SMTP settings removed'); } });
    await expect(notifications.staffNotice(notice)).rejects.toThrow('SMTP settings removed');
    expect(preparations).toBe(1);
    const rows = await db.forGym(f.gymId, tx => tx.select().from(emailDeliveries));
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.state === 'not_accepted')).toBe(true);
    expect(f.fake.messages).toHaveLength(0);
  });
  it('keeps possibly delivered dunning links usable, and neither sends nor mints again', async () => {
    const f = await fixture(), notice = await f.notice(uuidv7());
    f.fake.respondNext(new DeliveryError('unknown', 'Reply lost'));
    await expect(f.notifications.dunning({ ...notice, actionRequired: false })).rejects.toThrow('Reply lost');
    await f.notifications.dunning({ ...notice, actionRequired: false });
    const links = await f.links();
    expect(links).toHaveLength(2);
    expect(links.every(link => link.revokedAt === null)).toBe(true);
  });
  it('revokes the links of a refused or suppressed dunning attempt and sends fresh ones on retry', async () => {
    for (const failure of [new DeliveryError('not_accepted', 'Refused'), { status: 'suppressed', reason: 'disabled' } as const]) {
      const f = await fixture(), notice = await f.notice(uuidv7());
      f.fake.respondNext(failure);
      await expect(f.notifications.dunning({ ...notice, actionRequired: false })).rejects.toThrow();
      expect((await f.links()).every(link => link.revokedAt !== null)).toBe(true);
      await f.notifications.dunning({ ...notice, actionRequired: false });
      expect(f.fake.messages).toHaveLength(1);
      expect((await f.links()).filter(link => link.revokedAt === null)).toHaveLength(2);
    }
  });
  it('sends manual payment guidance once, with no link', async () => {
    const f = await fixture(undefined, 32, 'CAD'), notice = await f.notice(uuidv7());
    await f.notifications.dunning({ ...notice, actionRequired: false });
    await f.notifications.dunning({ ...notice, actionRequired: false });
    expect(f.fake.messages).toHaveLength(1);
    expect(f.fake.messages[0]!.text).toContain('Contact the gym to arrange a manual payment');
    expect(await f.links()).toEqual([]);
  });
  it('a retry reaches only the staff the notice provably did not reach', async () => {
    const f = await fixture(['first@example.invalid', 'second@example.invalid']), notice = await f.notice(uuidv7());
    const sent: EmailMessage[] = [];
    let refuse = true;
    f.holder.email = { async sendEmail(message) {
      if (refuse && message.to === 'second@example.invalid') throw new DeliveryError('not_accepted', 'Refused');
      sent.push(message);
      return { status: 'sent', messageId: 'mail_' + sent.length };
    } };
    await expect(f.notifications.staffNotice(notice)).rejects.toThrow('Refused');
    refuse = false;
    await f.notifications.staffNotice(notice);
    expect(sent.map(message => message.to)).toEqual(['first@example.invalid', 'second@example.invalid']);
  });
  it('a staff notice reaches the good recipient after a refused one, and its retry only the refused one', async () => {
    const f = await fixture(['bad@example.invalid', 'good@example.invalid']), notice = await f.notice(uuidv7());
    const sent: string[] = [];
    let refuse = true;
    f.holder.email = { async sendEmail(message) {
      if (refuse && message.to === 'bad@example.invalid') throw new DeliveryError('not_accepted', 'Refused');
      sent.push(message.to);
      return { status: 'sent', messageId: 'mail_' + sent.length };
    } };
    await expect(f.notifications.staffNotice({ ...notice, reason: 'refund_failed', refund })).rejects.toThrow('Refused');
    expect(sent).toEqual(['good@example.invalid']);
    refuse = false;
    await f.notifications.staffNotice({ ...notice, reason: 'refund_failed', refund });
    expect(sent).toEqual(['good@example.invalid', 'bad@example.invalid']);
  });
  it('a member notice is keyed without its address, so an address changed between retries gets no second notice', async () => {
    const f = await fixture(), notice = await f.notice(uuidv7());
    f.fake.respondNext(new DeliveryError('unknown', 'Reply lost'));
    await expect(f.notifications.receipt(notice)).rejects.toThrow('Reply lost');
    await db.forGym(f.gymId, tx => tx.update(households).set({ email: 'new@example.invalid' }).where(eq(households.id, f.household.id)));
    await f.notifications.receipt(notice);
    expect(f.fake.messages.filter(message => message.to === 'new@example.invalid')).toEqual([]);
    const rows = await db.forGym(f.gymId, tx => tx.select().from(emailDeliveries));
    expect(rows.map(row => row.key)).toEqual([`billing.receipt:${f.invoice.id}:${notice.generation}`]);
    expect(rows.some(row => row.key.includes(recipientDigest('payer@example.invalid')) || row.commandDigest)).toBe(false);
  });
  it('waits for an attempt still in flight instead of sending or minting', async () => {
    const f = await fixture(), notice = await f.notice(uuidv7());
    let finish!: () => void, entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    f.holder.email = { sendEmail: () => { entered(); return new Promise(resolve => { finish = () => resolve({ status: 'sent', messageId: 'mail_1' }); }); } };
    const first = f.notifications.dunning({ ...notice, actionRequired: false });
    await reached;
    await expect(f.notifications.dunning({ ...notice, actionRequired: false })).rejects.toThrow('still being sent');
    expect(await f.links()).toHaveLength(2);
    finish();
    await first;
  });
  it('a retried receipt job sends once, and a requested resend, a new job, sends again', async () => {
    const f = await fixture(), paidAt = f.clock.now();
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ status: 'paid', paidAt }).where(eq(invoices.id, f.invoice.id)));
    const [job] = createPaymentJobs({ scope: db.forGym, notifications: f.notifications, detachCard: async () => undefined });
    const run = (jobId: string) => job!.handler({ invoiceId: f.invoice.id }, { gymId: f.gymId, jobId, timezone: 'UTC', attempt: 1, clock: f.clock });
    const jobId = uuidv7();
    await run(jobId); await run(jobId);
    expect(f.fake.messages).toHaveLength(1);
    await run(uuidv7());
    expect(f.fake.messages).toHaveLength(2);
  });
});

it('recovers a refused dunning outcome after two rolled-back writes and retries only the non-send', async () => {
  const f = await fixture(), notice = { ...await f.notice(uuidv7()), actionRequired: false };
  let failures = 0, writes = 0;
  f.holder.email = { async sendEmail() { failures = 2; throw new DeliveryError('not_accepted', 'SMTP refused'); } };
  const notifications = createTransitionNotifications({ clock: f.clock,
    scope: (gymId, fn) => db.forGym(gymId, async tx => {
      const result = await fn(tx);
      if (failures > 0) { failures--; writes++; throw new Error('Outcome transaction failed'); }
      return result;
    }), settings: createGymSettingsAccessor({ scope: db.forGym }), staffRecipients: async () => [],
    prepare: async () => ({ email: f.holder.email, origin: 'https://gym.example.invalid' }) });
  await expect(notifications.dunning(notice)).rejects.toThrow('SMTP refused');
  expect(writes).toBe(2);
  expect((await f.links()).every(link => link.revokedAt !== null)).toBe(true);
  const [row] = await db.forGym(f.gymId, tx => tx.select().from(emailDeliveries));
  expect(row!.state).toBe('not_accepted');
  f.holder.email = f.fake;
  await notifications.dunning(notice);
  await notifications.dunning(notice);
  expect(f.fake.messages).toHaveLength(1);
});

it('releases a never-sent dunning reservation even when both link revocations fail', async () => {
  const f = await fixture(), notice = { ...await f.notice(uuidv7()), actionRequired: false };
  let revocations = 0;
  const notifications = createTransitionNotifications({ clock: f.clock,
    scope: (gymId, fn) => db.forGym(gymId, async tx => {
      const result = await fn(tx);
      if ((await tx.select().from(signedLinks)).some(link => link.revokedAt !== null)) {
        revocations++; throw new Error('Revocation transaction failed');
      }
      return result;
    }), settings: createGymSettingsAccessor({ scope: db.forGym }), staffRecipients: async () => [],
    prepare: async () => { throw new Error('SMTP unavailable'); } });
  await expect(notifications.dunning(notice)).rejects.toThrow('Billing email and cleanup failed');
  expect(revocations).toBe(2);
  const [row] = await db.forGym(f.gymId, tx => tx.select().from(emailDeliveries));
  expect(row!.state).toBe('not_accepted');
  expect((await f.links()).every(link => link.revokedAt === null)).toBe(true);
  expect(f.fake.messages).toHaveLength(0);
  await f.notifications.dunning(notice);
  await f.notifications.dunning(notice);
  expect(f.fake.messages).toHaveLength(1);
});

it('runs the cleanup once when member email is turned off before sending and a revocation fails', async () => {
  const f = await fixture(), notice = { ...await f.notice(uuidv7()), actionRequired: false };
  const settings = createGymSettingsAccessor({ scope: db.forGym });
  let reads = 0, revocations = 0;
  const notifications = createTransitionNotifications({ clock: f.clock,
    scope: (gymId, fn) => db.forGym(gymId, async tx => {
      const result = await fn(tx);
      if ((await tx.select().from(signedLinks)).some(link => link.revokedAt !== null)) {
        revocations++; throw new Error('Revocation transaction failed');
      }
      return result;
    }),
    // Recipients and the loop's check see email on; the check before sending sees it turned off.
    settings: { get: async gymId => ({ ...await settings.get(gymId), memberEmailsEnabled: ++reads < 3 }) },
    staffRecipients: async () => [], prepare: async () => ({ email: f.fake, origin: 'https://gym.example.invalid' }) });
  await expect(notifications.dunning(notice)).rejects.toThrow('Billing email cleanup failed');
  expect(revocations).toBe(2);
  const [row] = await db.forGym(f.gymId, tx => tx.select().from(emailDeliveries));
  expect(row!.state).toBe('not_accepted');
  expect(f.fake.messages).toHaveLength(0);
});

it('rolls dunning links and the reservation back together if the worker fails before commit', async () => {
  const f = await fixture(), notice = await f.notice(uuidv7());
  let crash = true;
  const notifications = createTransitionNotifications({ clock: f.clock,
    scope: (gymId, fn) => db.forGym(gymId, async tx => {
      const result = await fn(tx);
      if (crash && (await tx.select().from(signedLinks)).length === 2) throw new Error('Worker crashed');
      return result;
    }), settings: createGymSettingsAccessor({ scope: db.forGym }),
    prepare: async () => ({ email: f.fake, origin: 'https://gym.example.invalid' }), staffRecipients: async () => [] });
  await expect(notifications.dunning({ ...notice, actionRequired: false })).rejects.toThrow('Worker crashed');
  expect(await f.links()).toHaveLength(0);
  expect(await db.forGym(f.gymId, tx => tx.select().from(emailDeliveries))).toHaveLength(0);
  expect(f.fake.messages).toHaveLength(0);
  crash = false;
  await notifications.dunning({ ...notice, actionRequired: false });
  expect(await f.links()).toHaveLength(2);
  expect(f.fake.messages).toHaveLength(1);
});
