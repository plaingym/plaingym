// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, emailOutbox, gyms, households, invoiceLineItems, invoices, memberships,
  paymentAttempts, paymentMethods, payments, plans, uuidv7 } from '@plaingym/db';
import { createFactories } from '@plaingym/db/testing/factories';
import type { useTestDatabase } from '@plaingym/db/testing/database';
import { TestClock } from '../../core/clock.js';
import { chargingPayments } from '../demo-service.test-helper.js';
import { billingSeed } from './billing.js';
import { membersSeed } from './members.js';

export function provider(gymId: string, clock: TestClock) {
  const declinedMethods = new Set<string>(), createdCards = new Map<string, string>();
  const payments = new (chargingPayments(id => declinedMethods.has(id)))(gymId, clock);
  const createCustomer = vi.spyOn(payments, 'createCustomer');
  const seedCard = vi.fn(async (customerId: string, householdId: string, declined: boolean) => {
    let id = createdCards.get(householdId);
    if (!id) {
      id = 'pm_' + uuidv7().replaceAll('-', ''); createdCards.set(householdId, id);
      payments.recordPaymentMethod({ id, customerId, last4: declined ? '0341' : '4242', expiresMonth: 12, expiresYear: 2030 });
      if (declined) declinedMethods.add(id);
    }
    return id;
  });
  return { gymId, mode: 'test' as const, payments, createCustomer, seedCard };
}
/** A new Vancouver gym with the sample members, a test-mode payment gateway and the billing seed, not yet run. */
export async function fixture(db: ReturnType<typeof useTestDatabase>, now = '2026-10-26T00:30:00Z') {
  const gymId = uuidv7(), timezone = 'America/Vancouver', clock = new TestClock(now);
  await createFactories(db)('gyms', gymId, { timezone, currency: 'CAD' });
  const context = { gymId, timezone, enabledModules: new Set<string>() }, scope = db.forGym;
  const gateway = provider(gymId, clock), paymentsFor = async () => gateway;
  const seed = billingSeed({ scope, clock, paymentsFor });
  await membersSeed({ scope, clock, pinSecret: null }).run(context);
  return { gymId, clock, context, gateway, seed };
}
export async function snapshot(db: ReturnType<typeof useTestDatabase>, gymId: string) {
  // Query plans can change after another gym is seeded; compare rows in a stable order.
  return db.forGym(gymId, async tx => ({
    plans: await tx.select().from(plans).orderBy(plans.id), households: await tx.select().from(households).orderBy(households.id),
    memberships: await tx.select().from(memberships).orderBy(memberships.id), invoices: await tx.select().from(invoices).orderBy(invoices.id),
    lines: await tx.select().from(invoiceLineItems).orderBy(invoiceLineItems.id), cards: await tx.select().from(paymentMethods).orderBy(paymentMethods.id),
    attempts: await tx.select().from(paymentAttempts).orderBy(paymentAttempts.id), payments: await tx.select().from(payments).orderBy(payments.id),
    audit: await tx.select().from(auditEvents).orderBy(auditEvents.id), emails: await tx.select().from(emailOutbox).orderBy(emailOutbox.id),
    gym: (await tx.select().from(gyms).where(eq(gyms.id, gymId)))[0]!,
  }));
}
