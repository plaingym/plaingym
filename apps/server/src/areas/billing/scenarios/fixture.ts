// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { households, uuidv7 } from '@plaingym/db';
import type { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { invoiceDetailSchema } from '@plaingym/shared/contracts';
import type { CreatePlanRequest, InvoiceDetail, Plan } from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import { TestClock } from '../../../core/clock.js';
import type { AssignMembership, MembershipLifecycle } from '../../../core/interfaces/membership-lifecycle.js';
import { FakePayments } from '../../../infra/payments/index.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createCatalogService } from '../catalog.js';
import { createMembershipService } from '../memberships.js';
import { calculateCycleInvoice, type CalculatedInvoice, type PricedMembership } from '../invoicing/index.js';

/** Real catalog/lifecycle, real PostgreSQL; only the external payment provider is fake. */
export async function billingFixture(db: ReturnType<typeof useTestDatabase>, options: {
  now?: string; timezone?: string; billingDay?: number; discount?: number;
} = {}) {
  const factory = createFactories(db), gymId = uuidv7();
  const timezone = options.timezone ?? 'America/Vancouver';
  await factory('gyms', gymId, { currency: 'CAD', timezone });
  const clock = new TestClock(options.now ?? '2028-01-31T20:00:00Z');
  const context = { gymId, actor: { kind: 'system' as const } };
  const home = await factory('households', gymId, { billingDay: options.billingDay ?? 31,
    familyDiscountBasisPoints: options.discount ?? 0 });
  const serviceOptions = { scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) };
  const catalog = createCatalogService(serviceOptions);
  const membershipService = createMembershipService(serviceOptions);
  const lifecycle: MembershipLifecycle = membershipService;
  const payments = new FakePayments(gymId, clock);
  const customerId = 'cus_scenario';
  payments.seedCustomer({ id: customerId, email: 'payer@example.invalid' });
  const ids: string[] = [];
  async function plan(overrides: Partial<CreatePlanRequest> = {}) {
    return catalog.createPlan(context, { name: 'Monthly training', currency: 'CAD', amountCents: 10_000,
      interval: 'monthly', ...overrides });
  }
  async function assign(selected: Plan, overrides: Partial<AssignMembership> = {}) {
    const member = await factory('members', gymId, { householdId: home.id });
    const result = await lifecycle.assign(context, { id: uuidv7(), householdId: home.id, memberId: member.id,
      planId: selected.id, startsOn: '2028-01-31', nextDueOn: '2028-01-31',
      initialStatus: 'active', firstPeriod: 'next_billing_date', ...overrides });
    ids.push(result.id);
    return result;
  }
  async function priced(id: string): Promise<PricedMembership> {
    const membership = await lifecycle.get(gymId, id);
    const selected = await catalog.getPlan(gymId, membership.planId);
    return { membership, description: selected.name,
      taxRates: await Promise.all(selected.taxRateIds.map(id => catalog.getTaxRate(gymId, id))) };
  }
  async function pricing() {
    const [current] = await db.forGym(gymId, tx => tx.select().from(households).where(eq(households.id, home.id)));
    if (!current) throw new Error('Scenario household missing');
    return { householdId: home.id, currency: 'CAD' as const, billingDay: current.billingDay,
      familyDiscountBasisPoints: current.familyDiscountBasisPoints, discountDescription: 'Family discount' };
  }
  async function cycle(dueOn = localDate(clock.now(), timezone)) {
    return calculateCycleInvoice({ ...await pricing(), dueOn, memberships: await Promise.all(ids.map(priced)) });
  }
  return { db, factory, gymId, timezone, clock, context, home, catalog, lifecycle, membershipService,
    payments, customerId, plan, assign, priced, pricing, cycle };
}

/** Contract projection only: issuing, numbering and durable writes belong to the charge runner and payments service. */
export function invoiceDetail(calculated: CalculatedInvoice | null, clock: TestClock): InvoiceDetail {
  expect(calculated).not.toBeNull();
  if (!calculated) throw new Error('Expected a calculated invoice');
  const { lineItems, ...fields } = calculated, id = uuidv7(), createdAt = clock.now().toISOString();
  const detail = invoiceDetailSchema.parse({
    invoice: { ...fields, id, createdAt, status: 'open', number: 1, paidAt: null, needsReview: false,
      disputeId: null, disputeStatus: null },
    lineItems: lineItems.map(line => ({ ...line, id: uuidv7(), invoiceId: id, householdId: fields.householdId, createdAt })),
    payments: [], refunds: [],
  });
  expect(detail.lineItems.reduce((sum, line) => sum + line.amountCents, 0)).toBe(detail.invoice.amountCents);
  return detail;
}
