// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { attendances, members, payments, refunds } from './schema/index.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';
import { createFactories } from './testing/factories.js';

const database = useUpgradeTestDatabase('0027_class_packs', { applySecurity: true });
const factory = createFactories(database);

it('adds only the report time indexes to populated tables, preserving rows and gym isolation', async () => {
  const gymId = uuidv7(), otherGymId = uuidv7();
  await factory('gyms', gymId); await factory('gyms', otherGymId);
  const instant = new Date('2025-06-01T12:00:00Z');
  const household = await factory('households', gymId);
  // Explicit returning avoids requesting later generated member columns before the upgrade.
  const [member] = await database.forGym(gymId, tx => tx.insert(members).values({ gymId, householdId: household.id,
    firstName: 'Test', lastName: 'Member' }).returning({ id: members.id }));
  await factory('attendances', gymId, { memberId: member!.id, occurredAt: instant });
  const payment = await factory('payments', gymId, { paidAt: instant });
  await factory('refunds', gymId, { paymentId: payment.id, status: 'succeeded', resolvedAt: instant });
  await factory('refunds', gymId, { paymentId: payment.id, status: 'pending', resolvedAt: null });
  const read = (id: string) => database.forGym(id, async tx => ({ visits: await tx.select().from(attendances),
    receipts: await tx.select().from(payments), returned: await tx.select().from(refunds).orderBy(refunds.id) }));
  const before = await read(gymId);
  const maintenance = openConnection(database.maintenanceUrl, 1);
  const indexes = () => maintenance.sql<{ indexname: string; indexdef: string }[]>`
    select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname in
      ('attendances_gym_occurred_at_idx', 'payments_gym_paid_at_idx', 'refunds_gym_resolved_at_idx') order by indexname`;
  try {
    expect(await indexes()).toEqual([]);
    await migrateDatabase(database.maintenanceUrl);
    expect(await read(gymId)).toEqual(before);
    expect(await read(otherGymId)).toEqual({ visits: [], receipts: [], returned: [] });
    expect((await indexes()).map(row => row.indexdef)).toEqual([
      'CREATE INDEX attendances_gym_occurred_at_idx ON public.attendances USING btree (gym_id, occurred_at)',
      'CREATE INDEX payments_gym_paid_at_idx ON public.payments USING btree (gym_id, paid_at)',
      'CREATE INDEX refunds_gym_resolved_at_idx ON public.refunds USING btree (gym_id, resolved_at)',
    ]);
  } finally { await maintenance.close(); }
});
