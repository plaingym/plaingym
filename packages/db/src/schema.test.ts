// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { type PgTable } from 'drizzle-orm/pg-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { systemTables } from '../system-tables.mjs';
import * as schema from './schema/index.js';
import { uuidv7 } from './id.js';
import { createFactories, factoryTableNames } from './testing/factories.js';
import { useTestDatabase } from './testing/database.js';
const database = useTestDatabase();
const factory = createFactories(database);
const gymA = uuidv7(), gymB = uuidv7();
beforeAll(async () => { await factory('gyms', gymA); await factory('gyms', gymB); });
describe('factories and gym isolation', () => {
  it.each(factoryTableNames)('inserts a valid %s fixture and checks its access boundary', async (name) => {
    const gymId = name === 'gyms' ? uuidv7() : gymA;
    const row = await factory(name, gymId);
    expect(row.id).toMatch(/^[a-f0-9-]{14}7[a-f0-9-]{21}$/);
    const table = schema[name] as PgTable;
    const columns = getTableColumns(table);
    const system = systemTables.some((entry) => entry.name === getTableName(table));
    const rows = await database.forGym(gymB, (tx) => tx.select().from(table).where(eq(columns.id!, row.id)));
    // System tables deliberately require their infrastructure access boundary instead of RLS.
    expect(rows).toHaveLength(system ? 1 : 0);
    if (!system) {
      expect(await database.app.db.select().from(table).where(eq(columns.id!, row.id))).toEqual([]);
      expect(await database.forGym(gymA, (tx) => tx.select().from(table).where(and(eq(columns.id!, row.id), eq(columns.gymId!, gymA))))).toHaveLength(1);
    }
  });
  it('rejects forged cross-gym relationships and writes', async () => {
    const household = await factory('households', gymB);
    await expect(factory('members', gymA, { householdId: household.id })).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(database.forGym(gymA, (tx) => tx.insert(schema.households).values({ gymId: gymB, name: 'Forged' }))).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(database.app.db.insert(schema.households).values({ gymId: gymA, name: 'Unscoped' })).rejects.toMatchObject({ cause: { code: '42501' } });
    const member = await factory('members', gymB);
    expect(await database.forGym(gymA, (tx) => tx.update(schema.members).set({ firstName: 'Forged' }).where(eq(schema.members.id, member.id)).returning())).toEqual([]);
    expect(await database.forGym(gymA, (tx) => tx.delete(schema.members).where(eq(schema.members.id, member.id)).returning())).toEqual([]);
  });
  it('keeps household/member composite references within one household', async () => {
    const first = await factory('members', gymA);
    const second = await factory('households', gymA);
    const user = await factory('authUser', gymA);
    await expect(factory('householdUsers', gymA, { householdId: second.id, memberId: first.id, userId: user.id, scope: 'member' }))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(factory('memberships', gymA, { householdId: second.id, memberId: first.id }))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    const invoice = await factory('invoices', gymA, { householdId: second.id });
    await expect(factory('invoiceLineItems', gymA, { householdId: first.householdId, invoiceId: invoice.id }))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });
  it('preserves attended sessions and deduplicates install-level jobs', async () => {
    const session = await factory('classSessions', gymA);
    await factory('attendances', gymA, { sessionId: session.id });
    await expect(database.forGym(gymA, (tx) => tx.delete(schema.classSessions).where(eq(schema.classSessions.id, session.id))))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    const idempotencyKey = uuidv7();
    await factory('jobs', gymA, { gymId: null, idempotencyKey });
    await expect(factory('jobs', gymA, { gymId: null, idempotencyKey }))
      .rejects.toMatchObject({ cause: { code: '23505' } });
  });
  it('enforces billing and booking uniqueness without rejecting multiple one-off invoices', async () => {
    const household = await factory('households', gymA);
    const cycle = { householdId: household.id, kind: 'cycle', dueOn: '2026-02-01', periodStartsOn: '2026-02-01', periodEndsOn: '2026-03-01' };
    await factory('invoices', gymA, cycle);
    await expect(factory('invoices', gymA, cycle)).rejects.toMatchObject({ cause: { code: '23505' } });
    await factory('invoices', gymA, { householdId: household.id });
    await factory('invoices', gymA, { householdId: household.id });
    const attempt = await factory('paymentAttempts', gymA);
    await expect(factory('paymentAttempts', gymA, { invoiceId: attempt.invoiceId, attemptNumber: 2 })).rejects.toMatchObject({ cause: { code: '23505' } });
    const booking = await factory('classBookings', gymA);
    await expect(factory('classBookings', gymA, { sessionId: booking.sessionId, memberId: booking.memberId })).rejects.toMatchObject({ cause: { code: '23505' } });
    await database.forGym(gymA, (tx) => tx.update(schema.classBookings).set({ status: 'cancelled' }).where(eq(schema.classBookings.id, booking.id)));
    await factory('classBookings', gymA, { sessionId: booking.sessionId, memberId: booking.memberId });
  });
  it('protects append-only rows, immutable charge parameters and waiver bytes', async () => {
    const event = await factory('auditEvents', gymA);
    await expect(database.forGym(gymA, (tx) => tx.update(schema.auditEvents).set({ action: 'changed' }).where(eq(schema.auditEvents.id, event.id))))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(database.forGym(gymA, (tx) => tx.delete(schema.auditEvents).where(eq(schema.auditEvents.id, event.id))))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    const signature = await factory('waiverSignatures', gymA, { snapshot: '{ "b":2, "a":1 }\n' });
    const [stored] = await database.forGym(gymA, (tx) => tx.select().from(schema.waiverSignatures).where(eq(schema.waiverSignatures.id, signature.id)));
    expect(stored?.snapshot).toBe('{ "b":2, "a":1 }\n');
    await expect(database.forGym(gymA, (tx) => tx.update(schema.waiverSignatures).set({ snapshot: '{}' }).where(eq(schema.waiverSignatures.id, signature.id))))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    const attempt = await factory('paymentAttempts', gymA);
    await expect(database.forGym(gymA, (tx) => tx.update(schema.paymentAttempts).set({ amountCents: 1 }).where(eq(schema.paymentAttempts.id, attempt.id))))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await database.forGym(gymA, (tx) => tx.update(schema.paymentAttempts).set({ paymentIntentId: 'pi_test', status: 'succeeded' }).where(eq(schema.paymentAttempts.id, attempt.id)));
  });
});
