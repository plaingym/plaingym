// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { members, signedLinks, uuidv7 } from '@plaingym/db';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '../../../../../packages/db/src/testing/database.js';
import { createFactories } from '../../../../../packages/db/src/testing/factories.js';
import { TestClock } from '../../core/clock.js';
import { DeliveryError, FakeEmail, type Email, type EmailResult } from '../../infra/email/index.js';
import { emailInFlightMs } from '../../infra/email/deliveries.js';
import { createSignedLinksService } from './service.js';

const db = useTestDatabase(), factory = createFactories(db), t = createTranslator(locales.en ?? {});
async function fixture(amountCents?: number, currency?: string) {
  const gymId = uuidv7(), clock = new TestClock('2026-11-06T12:00:00Z'), fake = new FakeEmail();
  await factory('gyms', gymId, { memberEmailsEnabled: true, ...(currency ? { currency } : {}) });
  const household = await factory('households', gymId, { email: 'payer@example.test' });
  const member = await factory('members', gymId, { householdId: household.id, email: 'payer@example.test' });
  const invoice = await factory('invoices', gymId, { householdId: household.id, ...(amountCents ? { amountCents } : {}), ...(currency ? { currency } : {}) });
  const other = await factory('invoices', gymId, { householdId: household.id });
  const holder: { email: Email } = { email: fake };
  const links = createSignedLinksService({ scope: db.forGym, clock, delivery: { prepare: async () => ({ gymId, gymName: 'Gym',
    origin: 'https://gym.example.test', email: holder.email, memberEmailsEnabled: true, t }) } });
  const context = { gymId, actor: { kind: 'system' } } as const;
  const fields = { householdId: household.id, expiresAt: '2026-11-20T12:00:00.000Z' };
  const update = (sendGeneration: string = uuidv7()) => ({ ...fields, sendGeneration, purpose: 'update_card' as const });
  const pay = (sendGeneration: string = uuidv7(), invoiceId = invoice.id) => ({ ...fields, sendGeneration, purpose: 'pay_invoice' as const, invoiceId });
  const count = async () => (await db.forGym(gymId, tx => tx.select().from(signedLinks))).length;
  const tokenIn = (index: number) => /\/l\/([\w-]+)/.exec(fake.messages[index]!.text)![1]!;
  return { gymId, clock, fake, holder, household, member, invoice, other, links, context, fields, update, pay, count, tokenIn };
}

describe('one-off signed link send commands', () => {
  it.each(['onboarding', 'pay_invoice', 'update_card', 'sign_waiver'] as const)('%s: a replay sends once and a new generation sends again', async purpose => {
    const f = await fixture();
    const request = (sendGeneration: string) => {
      const base = { ...f.fields, sendGeneration };
      return purpose === 'pay_invoice' ? { ...base, purpose, invoiceId: f.invoice.id }
        : purpose === 'sign_waiver' ? { ...base, purpose, memberId: f.member.id } : { ...base, purpose };
    };
    const generation = uuidv7(), first = await f.links.send(f.context, request(generation));
    const replayed = await f.links.send(f.context, request(generation));
    expect(replayed).toEqual(first);
    expect(f.fake.messages).toHaveLength(1);
    expect(await f.count()).toBe(1);
    // The emailed credential is still the one in force.
    expect(await f.links.resolve(f.gymId, f.tokenIn(0))).toMatchObject({ status: 'active' });
    const resent = await f.links.send(f.context, request(uuidv7()));
    expect(resent.id).not.toBe(first.id);
    expect(f.fake.messages).toHaveLength(2);
  });
  it('ignores a retry\'s recalculated expiry, and a generation may differ only in case', async () => {
    const f = await fixture(), generation = uuidv7(), first = await f.links.send(f.context, f.update(generation));
    expect(await f.links.send(f.context, { ...f.update(generation.toUpperCase()), expiresAt: '2026-11-21T12:00:00.000Z' })).toEqual(first);
    expect(f.fake.messages).toHaveLength(1);
  });
  it('keeps a possibly delivered link usable and never sends another for the same generation', async () => {
    const f = await fixture(), generation = uuidv7();
    f.fake.respondNext(new DeliveryError('unknown', 'Reply lost'));
    await expect(f.links.send(f.context, f.update(generation))).rejects.toMatchObject({ code: 'unavailable' });
    const replayed = await f.links.send(f.context, f.update(generation));
    expect(replayed).toMatchObject({ revokedAt: null, outcome: 'unknown' });
    expect(f.fake.messages).toHaveLength(0);
    expect(await f.count()).toBe(1);
  });
  it.each([
    ['refused', new DeliveryError('not_accepted', 'Refused')],
    ['suppressed', { status: 'suppressed', reason: 'disabled' } as const],
  ])('revokes a %s attempt\'s link and sends a new one on retry', async (_name, failure) => {
    const f = await fixture(), generation = uuidv7();
    f.fake.respondNext(failure);
    await expect(f.links.send(f.context, f.update(generation))).rejects.toMatchObject({ code: 'unavailable' });
    const [failed] = await db.forGym(f.gymId, tx => tx.select().from(signedLinks));
    expect(failed!.revokedAt).not.toBeNull();
    const retried = await f.links.send(f.context, f.update(generation));
    expect(retried.id).not.toBe(failed!.id);
    expect(retried.revokedAt).toBeNull();
    expect(f.fake.messages).toHaveLength(1);
    expect(await f.links.send(f.context, f.update(generation))).toEqual(retried);
    expect(f.fake.messages).toHaveLength(1);
  });
  it('releases the reservation when a last-moment check stops the send before the transport', async () => {
    const f = await fixture(), generation = uuidv7();
    await db.forGym(f.gymId, tx => tx.update(members).set({ emailOptOut: true }).where(eq(members.id, f.member.id)));
    await expect(f.links.send(f.context, f.update(generation))).rejects.toMatchObject({ code: 'unavailable' });
    await db.forGym(f.gymId, tx => tx.update(members).set({ emailOptOut: false }).where(eq(members.id, f.member.id)));
    expect((await f.links.send(f.context, f.update(generation))).revokedAt).toBeNull();
    expect(f.fake.messages).toHaveLength(1);
  });
  it('refuses a generation reused for another request', async () => {
    const f = await fixture(), generation = uuidv7();
    await f.links.send(f.context, f.pay(generation));
    await expect(f.links.send(f.context, f.pay(generation, f.other.id))).rejects.toMatchObject({ code: 'conflict' });
    expect(f.fake.messages).toHaveLength(1);
  });
  it('replays a manual payment notice without a link', async () => {
    const f = await fixture(32, 'CAD'), generation = uuidv7(), first = await f.links.send(f.context, f.pay(generation));
    expect(first.revokedAt).not.toBeNull();
    expect(await f.links.send(f.context, f.pay(generation))).toEqual(first);
    expect(f.fake.messages).toHaveLength(1);
    expect(f.fake.messages[0]!.text).not.toContain('/l/');
  });
  it('holds a replay off while the first attempt is in flight, and leaves its link alone', async () => {
    const f = await fixture(), generation = uuidv7();
    let finish!: (result: EmailResult) => void, entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    f.holder.email = { sendEmail: () => { entered(); return new Promise<EmailResult>(resolve => { finish = resolve; }); } };
    const first = f.links.send(f.context, f.update(generation));
    await reached;
    await expect(f.links.send(f.context, f.update(generation))).rejects.toMatchObject({ code: 'conflict' });
    finish({ status: 'sent', messageId: 'mail_1' });
    expect((await first).revokedAt).toBeNull();
  });
  it('after a crash mid-send, a late replay returns the first link and sends nothing', async () => {
    const f = await fixture(), generation = uuidv7();
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    // This attempt never returns, as if its process died between the reservation and the outcome.
    f.holder.email = { sendEmail: () => { entered(); return new Promise<EmailResult>(() => undefined); } };
    void f.links.send(f.context, f.update(generation));
    await reached;
    f.clock.advance(emailInFlightMs);
    f.holder.email = f.fake;
    expect((await f.links.send(f.context, f.update(generation))).revokedAt).toBeNull();
    expect(f.fake.messages).toHaveLength(0);
    expect(await f.count()).toBe(1);
  });
  it('checks the invoice only for a command that runs, so a replay outlives a settled invoice', async () => {
    const f = await fixture(), generation = uuidv7(), first = await f.links.send(f.context, f.pay(generation));
    await expect(f.links.send(f.context, f.pay(uuidv7(), uuidv7()))).rejects.toMatchObject({ code: 'not_found' });
    expect(await f.links.send(f.context, f.pay(generation))).toEqual(first);
    expect(f.fake.messages).toHaveLength(1);
  });
});
