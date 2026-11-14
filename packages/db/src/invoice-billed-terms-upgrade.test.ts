// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { invoiceLineItems } from './schema/index.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0033_membership_scheduled_origin', { applySecurity: true });

it('fills historical membership terms only from the matching gym, invoice and membership issuance snapshot', async () => {
  const gymId = uuidv7(), otherGymId = uuidv7(), householdId = uuidv7(), memberId = uuidv7(), planId = uuidv7(), membershipId = uuidv7();
  const discount = { id: uuidv7(), discountId: uuidv7(), name: 'Student', percentBasisPoints: 2_000, amountCents: null,
    currency: 'USD', waivesSignupFee: false, duration: 'once', cyclesLeft: 1, planIds: [] };
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    for (const id of [gymId, otherGymId]) await maintenance.sql`insert into gyms (id, name, slug, currency) values (${id}, 'Gym', ${id}, 'USD')`;
    await maintenance.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Family')`;
    await maintenance.sql`insert into members (id, gym_id, household_id, first_name, last_name)
      values (${memberId}, ${gymId}, ${householdId}, 'Test', 'Member')`;
    await maintenance.sql`insert into plans (id, gym_id, name, amount_cents, currency, interval)
      values (${planId}, ${gymId}, 'Plan', 20000, 'USD', 'monthly')`;
    await maintenance.sql`insert into memberships (id, gym_id, household_id, member_id, plan_id, status, interval, amount_cents, currency,
      next_due_on, starts_on) values (${membershipId}, ${gymId}, ${householdId}, ${memberId}, ${planId}, 'active', 'monthly',
      20000, 'USD', '2026-12-01', '2026-11-01')`;
    const cases = [
      { name: 'discounted', snapshot: { membershipId, amountCents: 10_000, discount }, price: 10_000, discount },
      { name: 'undiscounted', snapshot: { membershipId, amountCents: 12_000, discount: null }, price: 12_000, discount: null },
      { name: 'missing', snapshot: undefined, price: null, discount: null },
      { name: 'other membership', snapshot: { membershipId: uuidv7(), amountCents: 13_000, discount: null }, price: null, discount: null },
      { name: 'invalid price', snapshot: { membershipId, amountCents: 'bad', discount: null }, price: null, discount: null },
      { name: 'foreign gym', snapshot: { membershipId, amountCents: 14_000, discount: null }, price: null, discount: null },
    ];
    const expected = [];
    for (const [index, test] of cases.entries()) {
      const invoiceId = uuidv7(), lineId = uuidv7(), chargeId = uuidv7();
      await maintenance.sql`insert into invoices (id, gym_id, household_id, kind, status, number, due_on, amount_cents, currency)
        values (${invoiceId}, ${gymId}, ${householdId}, 'one_off', 'open', ${index + 1}, '2026-11-01', 1234, 'USD')`;
      for (const [id, kind] of [[lineId, 'membership'], [chargeId, 'charge']])
        await maintenance.sql`insert into invoice_line_items (id, gym_id, household_id, invoice_id, membership_id, kind, description,
          amount_cents, currency) values (${id!}, ${gymId}, ${householdId}, ${invoiceId}, ${membershipId}, ${kind!}, 'Line', 1234, 'USD')`;
      const after = test.snapshot === undefined ? { membershipPricing: {} } : { membershipPricing: [test.snapshot] };
      await maintenance.sql`insert into audit_events (id, gym_id, actor_kind, action, target_type, target_id, after, occurred_at)
        values (${uuidv7()}, ${test.name === 'foreign gym' ? otherGymId : gymId}, 'system', 'billing.invoice.issued', 'invoice',
        ${invoiceId}, ${JSON.stringify(after)}::jsonb, '2026-11-01T12:00:00Z')`;
      expected.push({ id: lineId, billed_unit_amount_cents: test.price, billed_discount: test.discount },
        { id: chargeId, billed_unit_amount_cents: null, billed_discount: null });
    }
    const before = await maintenance.sql`select id, amount_cents, currency, description from invoice_line_items order by id`;
    await migrateDatabase(database.maintenanceUrl);
    expect(await maintenance.sql`select id, amount_cents, currency, description from invoice_line_items order by id`).toEqual(before);
    // Drizzle keeps the raw driver's JSON parser as text; use its typed projection for structured terms.
    expect(await database.forGym(gymId, tx => tx.select({ id: invoiceLineItems.id, billed_unit_amount_cents: invoiceLineItems.billedUnitAmountCents,
      billed_discount: invoiceLineItems.billedDiscount }).from(invoiceLineItems).orderBy(invoiceLineItems.id)))
      .toEqual(expected.toSorted((a, b) => a.id.localeCompare(b.id)));
    const known = expected[0]!;
    expect(await database.forGym(gymId, tx => tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.id, known.id))))
      .toMatchObject([{ billedUnitAmountCents: 10_000, billedDiscount: discount }]);
    expect(await database.forGym(otherGymId, tx => tx.select().from(invoiceLineItems))).toEqual([]);
    for (const id of [expected[1]!.id, known.id])
      await expect(maintenance.sql`update invoice_line_items set billed_unit_amount_cents = -1 where id = ${id}`)
        .rejects.toMatchObject({ code: '23514' });
  } finally { await maintenance.close(); }
});
