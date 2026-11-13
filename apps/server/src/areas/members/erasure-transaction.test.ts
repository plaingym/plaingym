// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq, inArray } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Inspect durable queue rows to prove erasure and redaction commit or roll back together.
import { auditEvents, classCreditEntries, households, members, memberships, leads, leadContacts, paymentMethods, waiverSignatures, jobs as jobRows, uuidv7, type forGym } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { authorize } from '../staff/auth.permissions.js';
import { errorHandler } from '../../core/errors.js';
import { createServerRegistry } from '../../core/registry.js';
import type { RequestEnvironment } from '../../core/context.js';
import { FakeJobs, PostgresJobs, type Jobs } from '../../infra/jobs/index.js';
import { createMembersService } from './members.js';
import { createMembersRoutes, redactCustomerJob, releaseErasedFilesJob } from './members.routes.js';
import { detachJob } from '../billing/payments.mutations.js';

const database = useTestDatabase(), factory = createFactories(database);
const gymId = uuidv7(), userId = uuidv7(), clock = new TestClock('2026-11-06T12:00:00Z');
beforeAll(async () => { await factory('gyms', gymId); await factory('authUser', gymId, { id: userId }); });

async function fixture(customerId: string | null) {
  const home = await factory('households', gymId, { stripeCustomerId: customerId });
  const person = await factory('members', gymId, { householdId: home.id, firstName: 'Original' });
  const lead = await factory('leads', gymId, { memberId: person.id, stage: 'lost', lostAt: clock.now(), lostReason: 'Private reason' });
  await factory('leadContacts', gymId, { leadId: lead.id, occurredAt: clock.now(), channel: 'call', note: 'Private note', createdBy: userId });
  const plan = await factory('plans', gymId);
  const membership = await factory('memberships', gymId, { householdId: home.id, memberId: person.id, planId: plan.id,
    switchOverrideReason: 'Private override', scheduledPlanId: plan.id, scheduledAmountCents: 8000, scheduledInterval: 'monthly',
    scheduledOn: '2026-12-01', scheduledOrigin: 'downgrade' });
  // Two active cards, a photo and a signed waiver: each needs cleanup outside the database once the erasure commits.
  const cards = [await factory('paymentMethods', gymId, { householdId: home.id }), await factory('paymentMethods', gymId, { householdId: home.id })];
  const photoKey = `${gymId}/members/${person.id}/${uuidv7()}`, signatureKey = `${gymId}/waivers/${uuidv7()}/signatures/${uuidv7()}.png`;
  await database.forGym(gymId, tx => tx.update(members).set({ photoKey }).where(eq(members.id, person.id)));
  await factory('waiverSignatures', gymId, { memberId: person.id, signatureImageKey: signatureKey });
  return { home, person, lead, membership, cards, files: [photoKey, signatureKey] };
}
const cleanupJobs = [redactCustomerJob, detachJob, releaseErasedFilesJob];
/** The durable cleanup rows the erasure committed for this member's cards and files. */
async function cleanupRows(cards: readonly { id: string }[], files: readonly string[]) {
  const rows = await database.forGym(gymId, tx => tx.select().from(jobRows).where(inArray(jobRows.name, cleanupJobs)));
  const value = (row: typeof rows[number]) => (row.payload as { value: { paymentMethodId?: string; keys?: string[] } }).value;
  return { detaches: rows.filter(row => row.name === detachJob && cards.some(card => card.id === value(row).paymentMethodId)),
    releases: rows.filter(row => row.name === releaseErasedFilesJob && value(row).keys?.[0] === files[0]) };
}
function app(queue: Pick<Jobs, 'enqueue'>, scope: typeof forGym = database.forGym) {
  const server = new OpenAPIHono<RequestEnvironment>(), redactCustomer = vi.fn(async () => undefined);
  server.use('*', async (ctx, next) => {
    ctx.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() },
      principal: { kind: 'staff', gymId, userId, roles: ['owner'] }, requestId: 'atomic-erasure', clock });
    await next();
  });
  server.onError(errorHandler);
  createServerRegistry({ routes: createMembersRoutes(createMembersService({ scope, clock }), undefined,
    { jobs: queue, redactCustomer, clock }) }).mount(server, authorize, new Set());
  return { redactCustomer, erase: (id: string) => server.request(`/api/members/${id}/anonymize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 1 }),
  }) };
}
async function redactions(customerId: string) {
  return (await database.forGym(gymId, tx => tx.select().from(jobRows).where(eq(jobRows.name, redactCustomerJob))))
    .filter(row => (row.payload as { value: { customerId: string } }).value.customerId === customerId);
}

describe.each(['fake', 'postgres'] as const)('%s atomic erasure', kind => {
  function queue() { return kind === 'fake' ? new FakeJobs(clock) : new PostgresJobs({ database, clock }); }
  it('rolls back erasure, audit and every cleanup job after their writes but before commit', async () => {
    const customerId = 'cus_rollback_' + uuidv7().replaceAll('-', ''), { home, person, lead, membership, cards, files } = await fixture(customerId);
    const credit = await factory('classCreditEntries', gymId, { memberId: person.id, reason: 'Original private reason' });
    const q = queue();
    const scope: typeof forGym = (gym, fn) => database.forGym(gym, async tx => {
      await fn(tx);
      expect((await tx.select().from(members).where(eq(members.id, person.id)))[0]!.anonymizedAt).not.toBeNull();
      expect((await tx.select().from(classCreditEntries).where(eq(classCreditEntries.id, credit.id)))[0]!.reason).toBe('');
      expect((await tx.select().from(paymentMethods).where(inArray(paymentMethods.id, cards.map(card => card.id)))).every(card => card.revokedAt)).toBe(true);
      if (kind === 'postgres') {
        const rows = await tx.select().from(jobRows).where(inArray(jobRows.name, cleanupJobs));
        const values = rows.map(row => JSON.stringify(row.payload));
        expect(values.some(value => value.includes(customerId))).toBe(true);
        for (const card of cards) expect(values.some(value => value.includes(card.id))).toBe(true);
        expect(values.some(value => value.includes(files[0]!))).toBe(true);
      }
      throw new Error('injected failure after writes');
    });
    const server = app(q, scope);
    expect((await server.erase(person.id)).status).toBe(500);
    const stored = await database.forGym(gymId, async tx => ({
      member: (await tx.select().from(members).where(eq(members.id, person.id)))[0]!,
      household: (await tx.select().from(households).where(eq(households.id, home.id)))[0]!,
      audits: await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'member.anonymized'), eq(auditEvents.targetId, person.id))),
    }));
    expect(stored.member).toMatchObject({ firstName: 'Original', anonymizedAt: null, revision: 1 });
    expect(stored.household.stripeCustomerId).toBe(customerId);
    expect(stored.audits).toEqual([]);
    expect((await database.forGym(gymId, tx => tx.select().from(classCreditEntries).where(eq(classCreditEntries.id, credit.id))))[0]!.reason)
      .toBe('Original private reason');
    expect((await database.forGym(gymId, tx => tx.select().from(leads).where(eq(leads.id, lead.id))))[0]!.lostReason).toBe('Private reason');
    expect(await database.forGym(gymId, tx => tx.select().from(leadContacts).where(eq(leadContacts.leadId, lead.id)))).toHaveLength(1);
    expect((await database.forGym(gymId, tx => tx.select().from(memberships).where(eq(memberships.id, membership.id))))[0]!)
      .toMatchObject({ switchOverrideReason: 'Private override', scheduledPlanId: membership.planId, scheduledOn: '2026-12-01' });
    expect(await redactions(customerId)).toEqual([]);
    // No card is left revoked without its detach job, and no file reference is lost without its release job.
    expect(await cleanupRows(cards, files)).toEqual({ detaches: [], releases: [] });
    expect((await database.forGym(gymId, tx => tx.select().from(paymentMethods).where(inArray(paymentMethods.id, cards.map(card => card.id)))))
      .every(card => card.revokedAt === null)).toBe(true);
    expect(stored.member.photoKey).toBe(files[0]);
    expect(await database.forGym(gymId, tx => tx.select().from(waiverSignatures).where(eq(waiverSignatures.memberId, person.id)))).toHaveLength(1);
    if (q instanceof FakeJobs) expect(q.jobs).toEqual([]);
    expect(server.redactCustomer).not.toHaveBeenCalled();
  });
  it('commits the erased member with its redaction, detach and release jobs before calling the provider', async () => {
    const customerId = 'cus_commit_' + uuidv7().replaceAll('-', ''), { home, person, lead, membership, cards, files } = await fixture(customerId);
    const otherMembership = await factory('memberships', gymId, { switchOverrideReason: 'Another member override' });
    const credit = await factory('classCreditEntries', gymId, { memberId: person.id, reason: 'Private adjustment detail' });
    const draw = await factory('classCreditEntries', gymId, { memberId: person.id, credits: -1,
      lotId: credit.id, reason: 'Private negative detail' });
    const use = await factory('classCreditEntries', gymId, { memberId: person.id, kind: 'use', credits: -1,
      lotId: credit.id, attendanceId: uuidv7(), adjustmentId: null, reason: null });
    const other = await factory('classCreditEntries', gymId, { reason: 'Another member detail' });
    const q = queue(), server = app(q);
    server.redactCustomer.mockImplementation(async () => {
      const [stored] = await database.forGym(gymId, tx => tx.select().from(households).where(eq(households.id, home.id)));
      expect(stored!.stripeCustomerId).toBeNull();
      if (q instanceof FakeJobs) expect(q.jobs).toHaveLength(4);
      else expect(await redactions(customerId)).toHaveLength(1);
    });
    expect((await server.erase(person.id)).status).toBe(200);
    const [stored] = await database.forGym(gymId, tx => tx.select().from(members).where(eq(members.id, person.id)));
    expect(stored!.anonymizedAt).toEqual(clock.now());
    const ledger = await database.forGym(gymId, tx => tx.select().from(classCreditEntries).where(eq(classCreditEntries.memberId, person.id)));
    expect(ledger).toHaveLength(3);
    expect(ledger).toEqual(expect.arrayContaining([{ ...credit, reason: '' }, { ...draw, reason: '' }, use]));
    expect((await database.forGym(gymId, tx => tx.select().from(classCreditEntries).where(eq(classCreditEntries.id, other.id))))[0]!.reason)
      .toBe('Another member detail');
    expect((await database.forGym(gymId, tx => tx.select().from(leads).where(eq(leads.id, lead.id))))[0]).toMatchObject({ stage: 'lost', lostReason: null });
    expect(await database.forGym(gymId, tx => tx.select().from(leadContacts).where(eq(leadContacts.leadId, lead.id)))).toEqual([]);
    const overrideReason = async (id: string) => (await database.forGym(gymId, tx => tx.select().from(memberships)
      .where(eq(memberships.id, id))))[0]!.switchOverrideReason;
    expect(await overrideReason(membership.id)).toBeNull();
    expect(await overrideReason(otherMembership.id)).toBe('Another member override');
    // The erasure's cancel drops the switch that hadn't applied yet.
    expect((await database.forGym(gymId, tx => tx.select().from(memberships).where(eq(memberships.id, membership.id))))[0]).toMatchObject({
      status: 'cancelled', scheduledPlanId: null, scheduledAmountCents: null, scheduledInterval: null, scheduledOn: null, scheduledOrigin: null });
    if (q instanceof FakeJobs) expect(q.jobs[0]).toMatchObject({ name: redactCustomerJob, payload: { customerId },
      options: { idempotencyKey: `redact:${customerId}`, maxAttempts: 12, timezone: 'UTC' }, runAt: new Date(clock.now().getTime() + 60_000) });
    else expect((await redactions(customerId))[0]).toMatchObject({ name: redactCustomerJob, maxAttempts: 12,
      payload: { timezone: 'UTC', value: { customerId } }, runAt: new Date(clock.now().getTime() + 60_000) });
    expect(server.redactCustomer).toHaveBeenCalledExactlyOnceWith(gymId, customerId);
    // One detach per revoked card (key `detach:<card>`, 12 attempts, billing details cleared first), and one release of the
    // photo and signature image, a minute after the inline attempt.
    expect((await database.forGym(gymId, tx => tx.select().from(paymentMethods).where(inArray(paymentMethods.id, cards.map(card => card.id)))))
      .every(card => card.revokedAt)).toBe(true);
    if (q instanceof FakeJobs) {
      expect(q.jobs.filter(job => job.name === detachJob).map(job => ({ payload: job.payload, options: job.options }))).toEqual(expect.arrayContaining(cards.map(card => ({
        payload: { paymentMethodId: card.id, redactBillingDetails: true },
        options: { gymId, timezone: 'UTC', maxAttempts: 12, idempotencyKey: `detach:${card.id}`, runAt: new Date(clock.now().getTime() + 60_000) } }))));
      expect(q.jobs.filter(job => job.name === detachJob)).toHaveLength(2);
      for (const job of q.jobs.filter(job => job.name === detachJob)) expect(job.runAt).toEqual(new Date(clock.now().getTime() + 60_000));
      expect(q.jobs.filter(job => job.name === releaseErasedFilesJob)).toEqual([expect.objectContaining({ payload: { keys: files },
        options: expect.objectContaining({ idempotencyKey: `release:${person.id}`, maxAttempts: 12 }), runAt: new Date(clock.now().getTime() + 60_000) })]);
    } else {
      const { detaches, releases } = await cleanupRows(cards, files);
      expect(detaches.map(row => row.payload)).toEqual(expect.arrayContaining(cards.map(card => expect.objectContaining({ timezone: 'UTC',
        value: { paymentMethodId: card.id, redactBillingDetails: true } }))));
      expect(detaches).toHaveLength(2);
      for (const row of detaches) {
        expect(row.maxAttempts).toBe(12);
        expect(row.runAt).toEqual(new Date(clock.now().getTime() + 60_000));
      }
      expect(releases).toEqual([expect.objectContaining({ maxAttempts: 12, payload: expect.objectContaining({ timezone: 'UTC', value: { keys: files } }),
        runAt: new Date(clock.now().getTime() + 60_000) })]);
    }
  });
  it('commits erasure without a redaction job when the customer ID is absent', async () => {
    const { person, cards, files } = await fixture(null), q = queue(), server = app(q);
    const redactionIds = async () => (await database.forGym(gymId, tx => tx.select({ id: jobRows.id }).from(jobRows)
      .where(eq(jobRows.name, redactCustomerJob)))).map(row => row.id).sort();
    const before = await redactionIds();
    expect((await server.erase(person.id)).status).toBe(200);
    expect((await database.forGym(gymId, tx => tx.select().from(members).where(eq(members.id, person.id))))[0]!.anonymizedAt).toEqual(clock.now());
    if (q instanceof FakeJobs) expect(q.jobs.map(job => job.name).sort()).toEqual([detachJob, detachJob, releaseErasedFilesJob].sort());
    else expect(await cleanupRows(cards, files)).toMatchObject({ detaches: [{}, {}], releases: [{}] });
    // No redaction row was added in either queue.
    expect(await redactionIds()).toEqual(before);
    expect(server.redactCustomer).not.toHaveBeenCalled();
  });
});
