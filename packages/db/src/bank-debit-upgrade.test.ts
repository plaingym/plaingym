// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { paymentMethods } from './schema/index.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';
import { createFactories } from './testing/factories.js';

const database = useUpgradeTestDatabase('0037_webhook_dispatch_recovery', { applySecurity: true });
const factory = createFactories(database);
const gymId = uuidv7(), householdId = uuidv7(), cardId = uuidv7();
const rejected = (code: string, constraint_name: string) => ({ cause: { code, constraint_name } });

beforeAll(async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Bank debit upgrade', ${gymId})`;
    await maintenance.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Household')`;
    await maintenance.sql`insert into payment_methods (id, gym_id, household_id, processor_id, brand, last4, expiry_month, expiry_year, is_default)
      values (${cardId}, ${gymId}, ${householdId}, 'pm_existing', 'visa', '4242', 12, 2030, true)`;
  } finally { await maintenance.close(); }
  await migrateDatabase(database.maintenanceUrl);
});

it('keeps existing saved cards and gives new gyms a disabled bank debit switch', async () => {
  expect(await database.forGym(gymId, tx => tx.select().from(paymentMethods))).toMatchObject([
    { id: cardId, type: 'card', bankName: null, mandateId: null, expiryMonth: 12, expiryYear: 2030, isDefault: true },
  ]);
  expect((await factory('gyms', uuidv7())).bankDebitsEnabled).toBe(false);
});

it('accepts a bank account without card expiry and rejects either expiry field', async () => {
  const method = { householdId, type: 'us_bank_account', bankName: 'Example Bank', mandateId: 'mandate_example' } as const;
  for (const expiry of [{ expiryMonth: 12 }, { expiryYear: 2030 }]) {
    await expect(factory('paymentMethods', gymId, { ...method, ...expiry }))
      .rejects.toMatchObject(rejected('23514', 'payment_methods_bank_expiry_check'));
  }
  expect(await factory('paymentMethods', gymId, method)).toMatchObject({ ...method, expiryMonth: null, expiryYear: null });
});

it('requires a processing timestamp and allows at most one unresolved attempt per invoice', async () => {
  const invoice = await factory('invoices', gymId, { householdId, currency: 'USD' });
  const attempt = { invoiceId: invoice.id, currency: invoice.currency };
  await expect(factory('paymentAttempts', gymId, { ...attempt, status: 'processing' }))
    .rejects.toMatchObject(rejected('23514', 'payment_attempts_processing_check'));
  const processingAt = new Date('2026-11-19T12:00:00Z');
  expect(await factory('paymentAttempts', gymId, { ...attempt, status: 'processing', processingAt }))
    .toMatchObject({ status: 'processing', processingAt });
  for (const status of ['pending', 'processing']) {
    await expect(factory('paymentAttempts', gymId, { ...attempt, attemptNumber: 2, status, processingAt }))
      .rejects.toMatchObject(rejected('23505', 'payment_attempts_unresolved_key'));
  }
});

it('permits multiple resolved attempts and a bank debit payment for an invoice', async () => {
  const invoice = await factory('invoices', gymId, { householdId, currency: 'USD' });
  const parent = { invoiceId: invoice.id, currency: invoice.currency };
  await factory('paymentAttempts', gymId, { ...parent, status: 'succeeded' });
  expect(await factory('paymentAttempts', gymId, { ...parent, attemptNumber: 2, status: 'failed' })).toMatchObject({ status: 'failed' });
  expect(await factory('payments', gymId, { ...parent, method: 'bank_debit' })).toMatchObject({ method: 'bank_debit' });
  await expect(factory('payments', gymId, { ...parent, method: 'ach' }))
    .rejects.toMatchObject(rejected('23514', 'payments_method_check'));
});
