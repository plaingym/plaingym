// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Inspect durable queue rows to prove erasure and redaction commit or roll back together.
import { auditEvents, classCreditEntries, households, members, jobs as jobRows, uuidv7, type forGym } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { authorize } from '../staff/auth.permissions.js';
import { errorHandler } from '../../core/errors.js';
import { createServerRegistry } from '../../core/registry.js';
import type { RequestEnvironment } from '../../core/context.js';
import { FakeJobs, PostgresJobs, type Jobs } from '../../infra/jobs/index.js';
import { createMembersService } from './members.js';
import { createMembersRoutes, redactCustomerJob } from './members.routes.js';

const database = useTestDatabase(), factory = createFactories(database);
const gymId = uuidv7(), userId = uuidv7(), clock = new TestClock('2026-11-06T12:00:00Z');
beforeAll(async () => { await factory('gyms', gymId); await factory('authUser', gymId, { id: userId }); });

async function fixture(customerId: string | null) {
  const home = await factory('households', gymId, { stripeCustomerId: customerId });
  const person = await factory('members', gymId, { householdId: home.id, firstName: 'Original' });
  return { home, person };
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
  it('rolls back erasure, audit and job after their writes but before commit', async () => {
    const customerId = 'cus_rollback_' + uuidv7().replaceAll('-', ''), { home, person } = await fixture(customerId);
    const credit = await factory('classCreditEntries', gymId, { memberId: person.id, reason: 'Original private reason' });
    const q = queue();
    const scope: typeof forGym = (gym, fn) => database.forGym(gym, async tx => {
      await fn(tx);
      expect((await tx.select().from(members).where(eq(members.id, person.id)))[0]!.anonymizedAt).not.toBeNull();
      expect((await tx.select().from(classCreditEntries).where(eq(classCreditEntries.id, credit.id)))[0]!.reason).toBe('');
      if (kind === 'postgres') expect((await tx.select().from(jobRows).where(eq(jobRows.name, redactCustomerJob)))
        .some(row => (row.payload as { value: { customerId: string } }).value.customerId === customerId)).toBe(true);
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
    expect(await redactions(customerId)).toEqual([]);
    if (q instanceof FakeJobs) expect(q.jobs).toEqual([]);
    expect(server.redactCustomer).not.toHaveBeenCalled();
  });
  it('commits the erased member and its redaction job before calling the provider', async () => {
    const customerId = 'cus_commit_' + uuidv7().replaceAll('-', ''), { home, person } = await fixture(customerId);
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
      if (q instanceof FakeJobs) expect(q.jobs).toHaveLength(1);
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
    if (q instanceof FakeJobs) expect(q.jobs[0]).toMatchObject({ name: redactCustomerJob, payload: { customerId },
      options: { idempotencyKey: `redact:${customerId}`, maxAttempts: 12, timezone: 'UTC' }, runAt: new Date(clock.now().getTime() + 60_000) });
    else expect((await redactions(customerId))[0]).toMatchObject({ name: redactCustomerJob, maxAttempts: 12,
      payload: { timezone: 'UTC', value: { customerId } }, runAt: new Date(clock.now().getTime() + 60_000) });
    expect(server.redactCustomer).toHaveBeenCalledExactlyOnceWith(gymId, customerId);
  });
  it('commits erasure without queuing a job when the customer ID is absent', async () => {
    const { person } = await fixture(null), q = queue(), server = app(q);
    const before = await database.forGym(gymId, tx => tx.select({ id: jobRows.id }).from(jobRows));
    expect((await server.erase(person.id)).status).toBe(200);
    expect((await database.forGym(gymId, tx => tx.select().from(members).where(eq(members.id, person.id))))[0]!.anonymizedAt).toEqual(clock.now());
    expect(await database.forGym(gymId, tx => tx.select({ id: jobRows.id }).from(jobRows))).toEqual(before);
    if (q instanceof FakeJobs) expect(q.jobs).toEqual([]);
    expect(server.redactCustomer).not.toHaveBeenCalled();
  });
});
