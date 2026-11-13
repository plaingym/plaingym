// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, discounts, households, invoiceLineItems, invoices, leads, members, memberships, membershipDiscounts, signedLinks,
  uuidv7, waiverSignatures } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
// eslint-disable-next-line no-restricted-imports, database/system-tables -- Test-only newer-release fixtures in immutable audit history.
import { openConnection } from '@plaingym/db/client';
import { AppError } from '@plaingym/shared';
import { TestClock } from '../../core/clock.js';
import { createGymSettingsAccessor } from '../../areas/settings/settings.js';
import { createWaiversService } from '../../areas/waivers/waivers.js';
import { createSignedLinkCheckout } from '../../areas/billing/signed-link-checkout.js';
import { createSignedLinksService } from '../../areas/links/service.js';
import { createInvoiceTransitions } from '../../areas/billing/transitions/index.js';
import { createChargeRunner } from '../../areas/billing/runner/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';
import { createJoinService, joinRecordWriteSchemas } from './join.service.js';
import { createJoinCleanup } from './join.cleanup.js';
import { configureJoinCleanup, jobs as joinJobs } from './join.jobs.js';

const db = useTestDatabase(), factory = createFactories(db), pngBase64 = demoSignaturePng().toString('base64');
const origin = 'https://gym.example.test', timezone = 'America/New_York';
const system = (gymId: string) => ({ gymId, actor: { kind: 'system' as const } });
// Submitted on 2026-10-29 (New York): the sixth local day after it ends at 2026-11-04 23:59:59.999 EST, after the fall clock change.
const submittedAt = '2026-10-29T18:00:00Z', sixthDayEnds = '2026-11-05T04:59:59.999Z', seventhDay = '2026-11-05T05:00:00Z';

async function fixture(start = submittedAt) {
  const gymId = uuidv7(), clock = new TestClock(start);
  await factory('gyms', gymId, { name: 'Unpaid joins', currency: 'CAD', timezone, billingEnabled: true, memberEmailsEnabled: true, websiteEnabled: false });
  const plan = await factory('plans', gymId, { name: 'Adult monthly', amountCents: 15000, currency: 'CAD', interval: 'monthly', signupFeeCents: 5000 });
  const templates = [await factory('waiverTemplates', gymId, { name: 'Participation', body: 'I understand the training risks.' })];
  const provider = new FakePayments(gymId, clock), paymentsFor = async () => provider;
  const uploads = new FakeUploads(gymId, clock), uploadsFor = async () => uploads;
  const waivers = createWaiversService({ scope: db.forGym, clock, uploadsFor });
  const checkout = createSignedLinkCheckout({ scope: db.forGym, clock, paymentsFor, originFor: async () => origin });
  const join = createJoinService({ scope: db.forGym, clock, waivers, checkout, paymentsConfigured: async id => id === gymId,
    invitations: { accept: vi.fn(), passwordRequired: async () => true }, accounts: { provisionUser: vi.fn() }, uploadsFor, paymentsFor });
  const transitions = createInvoiceTransitions({ scope: db.forGym, clock });
  const signer = (firstName: string) => ({ kind: 'self' as const, name: firstName + ' Joiner' });
  /** Admits `people` and returns the submission body that repeats the admission. */
  async function admit(email: string, people = 1, code?: string) {
    const persons = Array.from({ length: people }, (_, i) => ({ firstName: 'Avery' + 'ABCDEF'[i], lastName: 'Joiner', dateOfBirth: '1990-01-02' }));
    const contact = { name: 'Pat Payer', email }, extra = code === undefined ? {} : { code };
    const { data } = await join.admit(gymId, { planId: plan.id, contact, honeypot: '', ...extra, members: persons.map(member => ({ member,
      signatures: templates.map(t => ({ templateId: t.id, templateVersion: t.version, pngBase64, signer: signer(member.firstName) })) })) }, timezone);
    return { planId: plan.id, contact, honeypot: '', ...extra, members: persons.map((member, i) => ({ member,
      waivers: data[i]!.map(image => ({ ...image, consent: true as const, signer: signer(member.firstName) })) })) };
  }
  async function submit(email: string, people = 1, code?: string) {
    const body = await admit(email, people, code), { linkId } = await join.join(gymId, body, timezone, '127.0.0.1');
    const [link] = await db.forGym(gymId, tx => tx.select().from(signedLinks).where(eq(signedLinks.id, linkId)));
    return { body, linkId, householdId: link!.householdId, invoiceId: link!.invoiceId! };
  }
  /** The visitor opens Checkout and leaves without paying. */
  const openCheckout = async (linkId: string) => new URL(await join.checkout(gymId, linkId)).pathname.slice(1);
  const state = (householdId: string) => db.forGym(gymId, async tx => ({
    home: (await tx.select().from(households).where(eq(households.id, householdId)))[0],
    invoices: await tx.select().from(invoices).where(eq(invoices.householdId, householdId)),
    lines: await tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.householdId, householdId)),
    links: await tx.select().from(signedLinks).where(eq(signedLinks.householdId, householdId)),
    memberships: await tx.select().from(memberships).where(eq(memberships.householdId, householdId)),
    members: await tx.select().from(members).where(eq(members.householdId, householdId)),
    applications: await tx.select().from(membershipDiscounts).where(eq(membershipDiscounts.householdId, householdId)),
    audits: await tx.select().from(auditEvents),
  }));
  const signatures = (memberIds: string[]) => db.forGym(gymId, async tx =>
    (await tx.select().from(waiverSignatures)).filter(s => memberIds.includes(s.memberId)));
  const leadRows = (memberIds: string[]) => db.forGym(gymId, async tx => (await tx.select().from(leads)).filter(l => memberIds.includes(l.memberId)));
  const discount = (id: string) => db.forGym(gymId, async tx => (await tx.select().from(discounts).where(eq(discounts.id, id)))[0]!);
  const run = () => join.cleanup.run(gymId, timezone);
  return { gymId, clock, plan, provider, paymentsFor, uploadsFor, join, transitions, admit, submit, openCheckout, state, signatures, leadRows,
    discount, run };
}
const count = (audits: { action: string; targetId: string }[], action: string, targetId?: string) =>
  audits.filter(a => a.action === action && (targetId === undefined || a.targetId === targetId)).length;

describe('unpaid submitted joins', () => {
  it.each(['admitted', 'discounted', 'invoiced', 'received'] as const)('replays an extended public.join.%s record without duplicating writes', async (action) => {
    const f = await fixture(), code = await factory('discounts', f.gymId, { name: 'Spring', code: 'SPRING-20', percentBasisPoints: 2000,
      duration: 'forever', maxUses: 2 });
    const submitted = await f.submit('extended-' + action + '@example.invalid', 1, code.code!), before = await f.state(submitted.householdId);
    const row = before.audits.find(row => row.action === 'public.join.' + action)!;
    expect(row).toBeDefined();
    const after: Record<string, unknown> = { ...row.after as Record<string, unknown>, future: true };
    if (action === 'invoiced') after.next = (after.next as Record<string, unknown>[]).map(next => ({ ...next, future: true }));
    expect(joinRecordWriteSchemas[action].safeParse(after).success).toBe(false);
    const maintenance = openConnection(db.maintenanceUrl, 1);
    try {
      await maintenance.db.update(auditEvents).set({ after }).where(eq(auditEvents.id, row.id));
      if (action === 'discounted' || action === 'invoiced') {
        // Simulate interruption after the earlier stage committed but before the final receipt.
        const receipt = before.audits.find(row => row.action === 'public.join.received')!;
        await maintenance.db.update(auditEvents).set({ action: 'fixture.interrupted' }).where(eq(auditEvents.id, receipt.id));
      }
    } finally { await maintenance.close(); }
    await expect(f.join.join(f.gymId, { ...submitted.body, future: true }, timezone, '127.0.0.1')).rejects.toThrow();
    await expect(f.join.join(f.gymId, submitted.body, timezone, '127.0.0.1')).resolves.toEqual({ linkId: submitted.linkId });
    const replayed = await f.state(submitted.householdId);
    expect(replayed.invoices).toEqual(before.invoices);
    expect(replayed.memberships).toEqual(before.memberships);
    expect(replayed.applications).toEqual(before.applications);
    expect((await f.discount(code.id)).uses).toBe(1);
    expect(replayed.audits.filter(row => row.action === 'public.join.' + action)).toHaveLength(1);
  });
  it.each([
    ['the fall clock change', submittedAt, sixthDayEnds, seventhDay],
    // Submitted 2026-03-05 (EST); the seventh local day, 2026-03-12, starts at 04:00Z after the spring change.
    ['the spring clock change', '2026-03-05T18:00:00Z', '2026-03-12T03:59:59.999Z', '2026-03-12T04:00:00Z'],
  ])('keeps a join unpaid for six local days and voids it on the seventh, across %s', async (_label, start, sixth, seventh) => {
    const f = await fixture(start), join = await f.submit('abandoned@example.invalid');
    const sessionId = await f.openCheckout(join.linkId), expire = vi.spyOn(f.provider, 'expireCheckout');
    f.clock.set(sixth);
    expect(await f.run()).toBe(0);
    expect(expire).not.toHaveBeenCalled();
    expect((await f.state(join.householdId)).invoices.map(i => i.status)).toEqual(['open']);
    f.clock.set(seventh);
    configureJoinCleanup(f.join.cleanup);
    const job = joinJobs.find(j => j.id === 'public.join.cleanup')!;
    await job.handler({}, { gymId: f.gymId, timezone, clock: f.clock, jobId: uuidv7(), attempt: 1 });
    // The abandoned Checkout was confirmed closed before anything was voided.
    expect(expire.mock.calls).toEqual([[sessionId]]);
    const after = await f.state(join.householdId), memberIds = after.members.map(m => m.id);
    expect(after.invoices.map(i => [i.id, i.status, i.checkoutSessionId])).toEqual([[join.invoiceId, 'void', sessionId]]);
    expect(after.lines.length).toBeGreaterThan(0);
    expect(after.links.map(l => [l.id, l.revokedAt])).toEqual([[join.linkId, f.clock.now()]]);
    expect(after.memberships.map(m => [m.status, m.cancelledAt])).toEqual([['cancelled', f.clock.now()]]);
    // The prospects, their signed waivers and leads and the household stay for staff follow-up.
    expect(after.home).toBeDefined();
    expect(after.members.map(m => m.status)).toEqual(['prospect']);
    expect(await f.signatures(memberIds)).toHaveLength(1);
    expect(await f.leadRows(memberIds)).toHaveLength(1);
    expect(count(after.audits, 'billing.invoice.voided', join.invoiceId)).toBe(1);
    expect(count(after.audits, 'signed_link.revoked', join.linkId)).toBe(1);
    expect(count(after.audits, 'billing.membership.cancelled')).toBe(1);
    expect(after.audits.find(a => a.action === 'public.join.voided')).toMatchObject({ targetId: join.householdId, actorKind: 'system',
      after: { invoiceId: join.invoiceId, linkId: join.linkId, membershipIds: after.memberships.map(m => m.id) } });
    expect(await f.join.state(f.gymId, join.linkId)).toEqual({ status: 'closed' });
    expect(await f.run()).toBe(0);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('gives back the uses a code took exactly once, over two runs and two concurrent ones', async () => {
    const f = await fixture(), code = await factory('discounts', f.gymId, { name: 'Spring', code: 'SPRING-20', percentBasisPoints: 2000,
      duration: 'forever', maxUses: 2 });
    const join = await f.submit('code@example.invalid', 2, 'spring-20');
    await f.openCheckout(join.linkId);
    expect(await f.discount(code.id)).toMatchObject({ uses: 2 });
    f.clock.set(seventhDay);
    const [first, second] = await Promise.all([f.run(), f.run()]);
    expect(first + second).toBe(1);
    expect(await f.run()).toBe(0);
    expect(await f.join.cleanup.voidUnpaid(f.gymId, join.householdId, timezone)).toBe(false);
    const after = await f.state(join.householdId);
    expect(await f.discount(code.id)).toMatchObject({ uses: 0, revision: code.revision + 2 });
    expect(after.applications.map(a => [a.discountId, a.endReason])).toEqual([[code.id, 'released'], [code.id, 'released']]);
    expect(after.memberships.map(m => m.status)).toEqual(['cancelled', 'cancelled']);
    expect(count(after.audits, 'billing.discount.uses_released', code.id)).toBe(1);
    expect(after.audits.find(a => a.action === 'billing.discount.uses_released')).toMatchObject({ before: { uses: 2 }, after: { uses: 0 } });
    expect(count(after.audits, 'public.join.voided')).toBe(1);
    expect(after.audits.find(a => a.action === 'public.join.voided')!.after).toMatchObject({ discountId: code.id, usesReleased: 2 });
    // A replayed submission takes no use and starts nothing.
    expect((await f.join.join(f.gymId, join.body, timezone, '127.0.0.1')).linkId).toBe(join.linkId);
    expect(await f.discount(code.id)).toMatchObject({ uses: 0 });
    expect((await f.state(join.householdId)).memberships.map(m => m.status)).toEqual(['cancelled', 'cancelled']);
    // The returned uses are available to the next join.
    await expect(f.submit('next@example.invalid', 2, 'SPRING-20')).resolves.toBeDefined();
    expect(await f.discount(code.id)).toMatchObject({ uses: 2 });
  });

  it('keeps the uses of a join paid on the sixth day', async () => {
    const f = await fixture(), code = await factory('discounts', f.gymId, { name: 'Spring', code: 'SPRING-20', percentBasisPoints: 2000,
      duration: 'forever', maxUses: 5 });
    const join = await f.submit('paid@example.invalid', 1, 'SPRING-20');
    f.clock.set(sixthDayEnds);
    const [bill] = (await f.state(join.householdId)).invoices;
    await f.transitions.manualPayment(system(f.gymId), { invoiceId: bill!.id, paymentId: uuidv7(), method: 'cash',
      amountCents: bill!.amountCents, currency: bill!.currency, paidAt: f.clock.now().toISOString() });
    f.clock.set(seventhDay);
    expect(await f.run()).toBe(0);
    const after = await f.state(join.householdId);
    expect(after.invoices.map(i => i.status)).toEqual(['paid']);
    expect(after.links[0]!.revokedAt).toBeNull();
    expect(after.memberships.map(m => m.status)).not.toContain('cancelled');
    expect(after.applications.map(a => a.endReason)).toEqual([null]);
    expect(await f.discount(code.id)).toMatchObject({ uses: 1 });
    expect(count(after.audits, 'public.join.voided') + count(after.audits, 'public.join.retained')).toBe(0);
  });

  it('refuses a payment recorded after the void, as for any void invoice', async () => {
    const f = await fixture(), join = await f.submit('late@example.invalid');
    f.clock.set(seventhDay);
    expect(await f.run()).toBe(1);
    const [bill] = (await f.state(join.householdId)).invoices;
    const late = f.transitions.manualPayment(system(f.gymId), { invoiceId: bill!.id, paymentId: uuidv7(), method: 'cash',
      amountCents: bill!.amountCents, currency: bill!.currency, paidAt: f.clock.now().toISOString() });
    await expect(late).rejects.toMatchObject({ code: 'conflict' });
    await expect(late).rejects.toBeInstanceOf(AppError);
    await expect(f.join.checkout(f.gymId, join.linkId)).rejects.toBeInstanceOf(AppError);
    const after = await f.state(join.householdId);
    expect(after.invoices.map(i => [i.status, i.paidAt])).toEqual([['void', null]]);
    expect(after.memberships.map(m => m.status)).toEqual(['cancelled']);
  });

  it('waits while a completed Checkout may hold a payment not yet recorded', async () => {
    const f = await fixture(), join = await f.submit('completed@example.invalid'), sessionId = await f.openCheckout(join.linkId);
    f.provider.completeCheckout(sessionId);
    f.clock.set(seventhDay);
    expect(await f.run()).toBe(0);
    f.clock.set('2026-11-12T08:00:00Z');
    expect(await f.run()).toBe(0);
    const after = await f.state(join.householdId);
    expect(after.invoices.map(i => i.status)).toEqual(['open']);
    expect(after.links[0]!.revokedAt).toBeNull();
    expect(after.memberships.map(m => m.status)).toEqual(['pending']);
    // Not kept for good either: once the payment is recorded, the join completes as usual.
    expect(count(after.audits, 'public.join.voided') + count(after.audits, 'public.join.retained')).toBe(0);
  });

  it('keeps a join staff followed up on, and checks it no more', async () => {
    const f = await fixture(), code = await factory('discounts', f.gymId, { name: 'Spring', code: 'SPRING-20', percentBasisPoints: 2000,
      duration: 'forever', maxUses: 5 });
    const join = await f.submit('staff@example.invalid', 1, 'SPRING-20');
    await f.openCheckout(join.linkId);
    f.clock.set('2026-10-31T18:00:00Z');
    await createSignedLinksService({ scope: db.forGym, clock: f.clock }).create(system(f.gymId), { purpose: 'pay_invoice',
      invoiceId: join.invoiceId, householdId: join.householdId, expiresAt: new Date('2026-11-20T00:00:00Z').toISOString() });
    f.clock.set(seventhDay);
    const expire = vi.spyOn(f.provider, 'expireCheckout');
    expect(await f.run()).toBe(0);
    // A kept join's sessions are left alone: a payer may be in the follow-up link's Checkout.
    expect(expire).not.toHaveBeenCalled();
    const after = await f.state(join.householdId);
    expect(after.invoices.map(i => i.status)).toEqual(['open']);
    expect(after.memberships.map(m => m.status)).toEqual(['pending']);
    expect(await f.discount(code.id)).toMatchObject({ uses: 1 });
    expect(count(after.audits, 'public.join.retained', join.householdId)).toBe(1);
    expect(await f.run()).toBe(0);
    expect(count((await f.state(join.householdId)).audits, 'public.join.retained', join.householdId)).toBe(1);
  });

  it('voids a join whose household holds only a spare link revoked before use', async () => {
    // A concurrent submission, or a link whose delivery failed, leaves a link revoked before anyone used it.
    const f = await fixture(), join = await f.submit('spare@example.invalid'), sessionId = await f.openCheckout(join.linkId);
    const links = createSignedLinksService({ scope: db.forGym, clock: f.clock });
    const spare = await links.create(system(f.gymId), { purpose: 'pay_invoice', invoiceId: join.invoiceId, householdId: join.householdId,
      expiresAt: new Date('2026-10-30T18:00:00Z').toISOString() });
    await links.revoke(system(f.gymId), spare.link.id);
    f.clock.set(seventhDay);
    const expire = vi.spyOn(f.provider, 'expireCheckout');
    expect(await f.run()).toBe(1);
    expect(expire.mock.calls).toEqual([[sessionId]]);
    const after = await f.state(join.householdId);
    expect(after.invoices.map(i => i.status)).toEqual(['void']);
    expect(count(after.audits, 'public.join.retained', join.householdId)).toBe(0);
  });

  it('voids an invoice the runner held as overdue the same day', async () => {
    // Admitted on 2026-10-29 and submitted the next day: the invoice is due on the join date, so the runner's overdue
    // hold (over seven days past due) and the seventh day after submission both fall on 2026-11-06.
    const f = await fixture(), body = await f.admit('held@example.invalid');
    f.clock.set('2026-10-30T18:00:00Z');
    const { linkId } = await f.join.join(f.gymId, body, timezone, '127.0.0.1');
    const runner = createChargeRunner({ scope: db.forGym, clock: f.clock, transitions: f.transitions, jobs: new FakeJobs(f.clock),
      settings: createGymSettingsAccessor({ scope: db.forGym, clock: f.clock }), payments: f.paymentsFor });
    f.clock.set('2026-11-06T09:00:00Z');
    expect((await runner.daily(f.gymId)).errors).toEqual([]);
    const [link] = await db.forGym(f.gymId, tx => tx.select().from(signedLinks).where(eq(signedLinks.id, linkId)));
    expect((await f.state(link!.householdId)).invoices.map(i => [i.status, i.needsReview])).toEqual([['open', true]]);
    expect(await f.run()).toBe(1);
    expect((await f.state(link!.householdId)).invoices.map(i => i.status)).toEqual(['void']);
  });

  it('without the payments resolver, voids only a join that never opened Checkout', async () => {
    const f = await fixture(), opened = await f.submit('opened@example.invalid'), never = await f.submit('never@example.invalid');
    await f.openCheckout(opened.linkId);
    const cleanup = createJoinCleanup({ scope: db.forGym, clock: f.clock, uploadsFor: f.uploadsFor });
    f.clock.set(seventhDay);
    expect(await cleanup.run(f.gymId, timezone)).toBe(1);
    expect((await f.state(opened.householdId)).invoices.map(i => i.status)).toEqual(['open']);
    expect((await f.state(never.householdId)).invoices.map(i => i.status)).toEqual(['void']);
    expect(await f.run()).toBe(1);
    expect((await f.state(opened.householdId)).invoices.map(i => i.status)).toEqual(['void']);
  });

  it('voids only the gym whose cleanup runs', async () => {
    const a = await fixture(), b = await fixture();
    const joinA = await a.submit('a@example.invalid'), joinB = await b.submit('b@example.invalid');
    a.clock.set(seventhDay); b.clock.set(seventhDay);
    expect(await a.run()).toBe(1);
    expect(await a.join.cleanup.voidUnpaid(a.gymId, joinB.householdId, timezone)).toBe(false);
    expect((await a.state(joinA.householdId)).invoices.map(i => i.status)).toEqual(['void']);
    const other = await b.state(joinB.householdId);
    expect(other.invoices.map(i => i.status)).toEqual(['open']);
    expect(other.memberships.map(m => m.status)).toEqual(['pending']);
    expect(other.links[0]!.revokedAt).toBeNull();
    expect(count(other.audits, 'public.join.voided')).toBe(0);
    expect(await b.run()).toBe(1);
    expect((await b.state(joinB.householdId)).invoices.map(i => i.status)).toEqual(['void']);
  });
});
