// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, households, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createMembersService } from './members.js';
import { createErasureJobs, redactCustomerJob } from './members.routes.js';
import { queueEarlierRedactions, redactEarlierJob, redactionQueuedAction } from './erasure-redaction.js';
import { FakePayments } from '../../infra/payments/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { TestClock } from '../../core/clock.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-11-03T12:00:00Z');
const gymA = uuidv7(), gymB = uuidv7(), secret = new Uint8Array(32).fill(7);
const service = createMembersService({ scope: database.forGym, clock, pinSecret: async () => secret });
beforeAll(async () => { await factory('gyms', gymA); await factory('gyms', gymB); });

/** An erased household, as `eraseMember` leaves it: the audit keeps the cleared customer ID. */
async function erased(gymId: string, customerId: string | null) {
  const home = await factory('households', gymId), person = await factory('members', gymId, { householdId: home.id });
  if (customerId) await database.forGym(gymId, tx => tx.update(households).set({ stripeCustomerId: customerId }).where(eq(households.id, home.id)));
  await service.eraseMember({ gymId, actor: { kind: 'system' } }, person.id, { revision: 1 }, { jobs: new FakeJobs(clock), timezone: 'UTC' });
  return home;
}
const customer = (tag: string) => `cus_${tag}_${uuidv7().replaceAll('-', '')}`;
const queue = (gymId: string, jobs: FakeJobs) => queueEarlierRedactions({ gymId, timezone: 'UTC', jobs, clock, scope: database.forGym });

describe('redaction of customers erased earlier', () => {
  it('queues each erased customer of the gym once, never another gym’s, and a rerun queues nothing new', async () => {
    const [one, two, other] = [customer('one'), customer('two'), customer('other')];
    await erased(gymA, one); await erased(gymA, two); await erased(gymA, null); await erased(gymB, other);
    const jobs = new FakeJobs(clock);
    expect(await queue(gymA, jobs)).toBe(2);
    expect(jobs.jobs.map(job => ({ name: job.name, payload: job.payload, gymId: job.options.gymId, key: job.options.idempotencyKey })))
      .toEqual(expect.arrayContaining([one, two].map(customerId => ({ name: redactCustomerJob, payload: { customerId }, gymId: gymA, key: `redact-earlier:${customerId}` }))));
    expect(jobs.jobs).toHaveLength(2);
    // Each queued customer is marked on its household's audit trail, so the check survives the queue pruning its finished jobs.
    const markers = await database.forGym(gymA, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, redactionQueuedAction)));
    expect(markers.map(marker => (marker.after as { stripeCustomerId: string }).stripeCustomerId).sort()).toEqual([one, two].sort());
    expect(markers.every(marker => marker.actorKind === 'system' && marker.targetType === 'household')).toBe(true);
    expect(await queue(gymA, jobs)).toBe(0);
    const pruned = new FakeJobs(clock);
    expect(await queue(gymA, pruned)).toBe(0);
    expect(pruned.jobs).toEqual([]);
    // A household erased afterwards is picked up by the next check, on top of the two already queued.
    const later = customer('later');
    await erased(gymA, later);
    expect(await queue(gymA, jobs)).toBe(1);
    expect(jobs.jobs.map(job => (job.payload as { customerId: string }).customerId)).toContain(later);
    // The other gym's customer was never read for gym A, and is queued only for gym B.
    expect(jobs.jobs.map(job => (job.payload as { customerId: string }).customerId)).not.toContain(other);
    const jobsB = new FakeJobs(clock);
    expect(await queue(gymB, jobsB)).toBe(1);
    expect(jobsB.jobs.map(job => ({ payload: job.payload, gymId: job.options.gymId }))).toEqual([{ payload: { customerId: other }, gymId: gymB }]);
    const marked = await database.forGym(gymB, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.action, redactionQueuedAction))));
    expect(marked.map(marker => (marker.after as { stripeCustomerId: string }).stripeCustomerId)).toEqual([other]);
  });
  it('is a daily job that queues the customers and whose redactions clear what the first release left at the provider', async () => {
    const leftover = customer('leftover');
    await erased(gymA, leftover);
    const payments = new FakePayments(gymA, clock), jobs = new FakeJobs(clock);
    // Erased by an earlier release: renamed and emptied, but still holding a phone, an individual name, custom fields and a tax ID.
    payments.seedCustomer({ id: leftover, email: 'payer@example.invalid', phone: '+15555550100', individualName: 'Pat Payer',
      customFields: [{ name: 'Member', value: 'Pat' }], taxIds: ['DE123456789'] });
    const registrations = createErasureJobs({ redactCustomer: (_gymId, id) => payments.redactCustomer(id), jobs, scope: database.forGym });
    const check = registrations.find(registration => registration.id === redactEarlierJob)!;
    expect(check.cron).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
    await check.handler({}, { jobId: 'check', gymId: gymA, timezone: 'UTC', attempt: 1, clock });
    const queued = jobs.jobs.filter(job => (job.payload as { customerId: string }).customerId === leftover);
    expect(queued).toHaveLength(1);
    const redact = registrations.find(registration => registration.id === redactCustomerJob)!;
    for (let run = 1; run <= 2; run++) await redact.handler(queued[0]!.payload, { jobId: 'redact', gymId: gymA, timezone: 'UTC', attempt: run, clock });
    expect(payments.customer(leftover)).toEqual({ name: 'Erased member', email: null, phone: null, address: null, shipping: null, description: null,
      individualName: null, businessName: null, customFields: null, taxIds: [] });
    // A check that runs again queues nothing, and one without a queue says so instead of passing silently.
    const before = jobs.jobs.length;
    await check.handler({}, { jobId: 'check', gymId: gymA, timezone: 'UTC', attempt: 2, clock });
    expect(jobs.jobs).toHaveLength(before);
    await expect(createErasureJobs({ redactCustomer: async () => undefined }).find(registration => registration.id === redactEarlierJob)!
      .handler({}, { jobId: 'check', gymId: gymA, timezone: 'UTC', attempt: 1, clock })).rejects.toThrow('not configured');
  });
  it('leaves a customer a household of the gym links today, and continues past the batch size on the next run', async () => {
    const reused = customer('reused'), [a, b, c] = [customer('a'), customer('b'), customer('c')];
    await erased(gymB, reused); await erased(gymB, a); await erased(gymB, b); await erased(gymB, c);
    // The gym has since linked the erased customer to another household (a restored or re-imported customer).
    const live = await factory('households', gymB);
    await database.forGym(gymB, tx => tx.update(households).set({ stripeCustomerId: reused }).where(eq(households.id, live.id)));
    const jobs = new FakeJobs(clock), pendingFor = (id: string) => jobs.jobs.filter(job => (job.payload as { customerId: string }).customerId === id);
    const done = jobs.jobs.length;
    expect(await queueEarlierRedactions({ gymId: gymB, timezone: 'UTC', jobs, clock, scope: database.forGym, batch: 2 })).toBe(2);
    expect(await queueEarlierRedactions({ gymId: gymB, timezone: 'UTC', jobs, clock, scope: database.forGym, batch: 2 })).toBe(1);
    expect(await queueEarlierRedactions({ gymId: gymB, timezone: 'UTC', jobs, clock, scope: database.forGym, batch: 2 })).toBe(0);
    expect([a, b, c].map(id => pendingFor(id).length)).toEqual([1, 1, 1]);
    expect(pendingFor(reused)).toEqual([]);
    expect(jobs.jobs.length).toBeGreaterThan(done);
    // Once the household lets the customer go, the next run queues it.
    await database.forGym(gymB, tx => tx.update(households).set({ stripeCustomerId: null }).where(eq(households.id, live.id)));
    expect(await queue(gymB, jobs)).toBe(1);
    expect(pendingFor(reused)).toHaveLength(1);
  });
  it('ignores audits whose recorded customer ID is not a Stripe customer ID', async () => {
    const home = await erased(gymA, null);
    await database.forGym(gymA, tx => tx.insert(auditEvents).values({ gymId: gymA, actorKind: 'system', action: 'household.anonymized', targetType: 'household',
      targetId: home.id, before: { stripeCustomerId: '../cus_x' }, occurredAt: clock.now() }));
    const jobs = new FakeJobs(clock), before = await database.forGym(gymA, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, redactionQueuedAction)));
    await queue(gymA, jobs);
    expect(jobs.jobs.every(job => /^cus_[A-Za-z0-9_]+$/.test((job.payload as { customerId: string }).customerId))).toBe(true);
    // Every marker written is for a job queued; the malformed ID got neither.
    expect((await database.forGym(gymA, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, redactionQueuedAction)))).length - before.length).toBe(jobs.jobs.length);
  });
});
