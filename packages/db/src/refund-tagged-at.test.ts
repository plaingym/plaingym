// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openConnection } from './client.js';
import { migrateDatabase } from './migrate.js';
import { refunds } from './schema/index.js';
import { uuidv7 } from './id.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0020_intake_rate_limits', { applySecurity: true });

it('adds a nullable marker that leaves every existing refund and reservation unmarked', async () => {
  const gymId = uuidv7(), householdId = uuidv7(), invoiceId = uuidv7(), paymentId = uuidv7();
  const reservationId = uuidv7(), refundedId = uuidv7(), later = uuidv7(), createdAt = '2026-10-01T12:00:00Z';
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`insert into gyms (id, name, slug, currency) values (${gymId}, 'Test Gym', ${gymId}, 'USD')`;
    await maintenance.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Household')`;
    await maintenance.sql`insert into invoices (id, gym_id, household_id, kind, status, number, due_on, amount_cents, currency)
      values (${invoiceId}, ${gymId}, ${householdId}, 'one_off', 'paid', 1, '2026-10-01', 10000, 'USD')`;
    await maintenance.sql`insert into payments (id, gym_id, invoice_id, method, amount_cents, currency, payment_intent_id, charge_id, paid_at)
      values (${paymentId}, ${gymId}, ${invoiceId}, 'card', 10000, 'USD', 'pi_old', 'ch_old', ${createdAt})`;
    await maintenance.sql`insert into refunds (id, gym_id, payment_id, amount_cents, currency, status, reason, created_at)
      values (${reservationId}, ${gymId}, ${paymentId}, 2500, 'USD', 'pending', 'Returned item', ${createdAt})`;
    await maintenance.sql`insert into refunds (id, gym_id, payment_id, amount_cents, currency, processor_id, status, resolved_at, created_at)
      values (${refundedId}, ${gymId}, ${paymentId}, 1000, 'USD', 're_old', 'succeeded', ${createdAt}, ${createdAt})`;
  } finally { await maintenance.close(); }

  await migrateDatabase(database.maintenanceUrl);
  const read = async (id: string) => (await database.forGym(gymId, tx => tx.select().from(refunds).where(eq(refunds.id, id))))[0];
  expect(await read(reservationId)).toMatchObject({ gymId, paymentId, amountCents: 2500, currency: 'USD', processorId: null,
    status: 'pending', reason: 'Returned item', resolvedAt: null, createdAt: new Date(createdAt), taggedAt: null });
  expect(await read(refundedId)).toMatchObject({ gymId, paymentId, amountCents: 1000, currency: 'USD', processorId: 're_old',
    status: 'succeeded', reason: null, resolvedAt: new Date(createdAt), createdAt: new Date(createdAt), taggedAt: null });

  // A previous-release insert omits the column and still works.
  const previous = openConnection(database.maintenanceUrl, 1);
  try {
    await previous.sql`insert into refunds (id, gym_id, payment_id, amount_cents, currency, created_at)
      values (${later}, ${gymId}, ${paymentId}, 500, 'USD', ${createdAt})`;
  } finally { await previous.close(); }
  // The app role can set it under row-level security after the upgrade.
  const taggedAt = new Date('2026-11-06T12:00:00Z');
  await database.forGym(gymId, tx => tx.update(refunds).set({ taggedAt }).where(eq(refunds.id, later)));
  expect(await read(later)).toMatchObject({ status: 'pending', taggedAt });
  expect(await read(reservationId)).toMatchObject({ taggedAt: null });
});
