// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { invoiceLineItems, memberships } from './schema/index.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0028_report_time_indexes', { applySecurity: true });
const newMembershipColumns = ['scheduled_plan_id', 'scheduled_amount_cents', 'scheduled_interval', 'scheduled_on', 'switch_override_reason'];

it('adds the plan switch columns to a populated database, leaves existing rows unchanged and enforces their rules', async () => {
  const gymId = uuidv7(), otherGymId = uuidv7(), householdId = uuidv7(), memberId = uuidv7();
  const planId = uuidv7(), otherPlanId = uuidv7(), foreignPlanId = uuidv7(), membershipId = uuidv7(), invoiceId = uuidv7();
  const lineIds = { membership: uuidv7(), signup_fee: uuidv7(), charge: uuidv7(), discount: uuidv7(), tax: uuidv7() };
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    for (const id of [gymId, otherGymId]) await maintenance.sql`insert into gyms (id, name, slug, currency) values (${id}, 'Gym', ${id}, 'USD')`;
    await maintenance.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Family')`;
    await maintenance.sql`insert into members (id, gym_id, household_id, first_name, last_name)
      values (${memberId}, ${gymId}, ${householdId}, 'Test', 'Member')`;
    for (const [id, gym] of [[planId, gymId], [otherPlanId, gymId], [foreignPlanId, otherGymId]] as const)
      await maintenance.sql`insert into plans (id, gym_id, name, amount_cents, currency, interval) values (${id}, ${gym}, 'Plan', 10000, 'USD', 'monthly')`;
    await maintenance.sql`insert into memberships (id, gym_id, household_id, member_id, plan_id, status, interval, amount_cents, currency,
      next_due_on, starts_on, commitment_ends_on) values (${membershipId}, ${gymId}, ${householdId}, ${memberId}, ${planId}, 'active',
      'monthly', 10000, 'USD', '2026-12-01', '2026-11-01', '2027-05-01')`;
    await maintenance.sql`insert into invoices (id, gym_id, household_id, kind, status, number, due_on, period_starts_on, period_ends_on,
      amount_cents, currency) values (${invoiceId}, ${gymId}, ${householdId}, 'cycle', 'open', 1, '2026-11-01', '2026-11-01', '2026-12-01',
      12000, 'USD')`;
    for (const [kind, id] of Object.entries(lineIds)) {
      const tax = kind === 'tax';
      await maintenance.sql`insert into invoice_line_items (id, gym_id, household_id, invoice_id, membership_id, kind, description,
        amount_cents, currency, tax_rate_millionths, tax_inclusive) values (${id}, ${gymId}, ${householdId}, ${invoiceId},
        ${kind === 'membership' || kind === 'signup_fee' ? membershipId : null}, ${kind}, ${kind}, 1000, 'USD',
        ${tax ? 50_000 : null}, ${tax ? false : null})`;
    }
    const beforeMemberships = await maintenance.sql`select * from memberships order by id`;
    const beforeLines = await maintenance.sql`select * from invoice_line_items order by id`;

    await migrateDatabase(database.maintenanceUrl);

    const afterMemberships = await maintenance.sql`select * from memberships order by id`;
    const afterLines = await maintenance.sql`select * from invoice_line_items order by id`;
    expect(afterMemberships).toEqual(beforeMemberships.map(row => ({ ...row, ...Object.fromEntries(newMembershipColumns.map(c => [c, null])) })));
    expect(afterLines).toEqual(beforeLines.map(row => ({ ...row, plan_id: null })));

    const rejected = (code: string) => expect.objectContaining({ code });
    // A scheduled change is all four columns or none.
    await expect(maintenance.sql`update memberships set scheduled_plan_id = ${otherPlanId} where id = ${membershipId}`)
      .rejects.toEqual(rejected('23514'));
    await expect(maintenance.sql`update memberships set scheduled_plan_id = ${otherPlanId}, scheduled_amount_cents = 9000,
      scheduled_interval = 'monthly' where id = ${membershipId}`).rejects.toEqual(rejected('23514'));
    await expect(maintenance.sql`update memberships set scheduled_plan_id = ${otherPlanId}, scheduled_amount_cents = -1,
      scheduled_interval = 'monthly', scheduled_on = '2026-12-01' where id = ${membershipId}`).rejects.toEqual(rejected('23514'));
    await expect(maintenance.sql`update memberships set scheduled_plan_id = ${otherPlanId}, scheduled_amount_cents = 9000,
      scheduled_interval = 'weekly', scheduled_on = '2026-12-01' where id = ${membershipId}`).rejects.toEqual(rejected('23514'));
    // The scheduled plan must be the same gym's.
    await expect(maintenance.sql`update memberships set scheduled_plan_id = ${foreignPlanId}, scheduled_amount_cents = 9000,
      scheduled_interval = 'monthly', scheduled_on = '2026-12-01' where id = ${membershipId}`).rejects.toEqual(rejected('23503'));
    // The override reason is 1-500 characters when set.
    for (const reason of ['', 'x'.repeat(501)])
      await expect(maintenance.sql`update memberships set switch_override_reason = ${reason} where id = ${membershipId}`)
        .rejects.toEqual(rejected('23514'));
    // A line's plan is only for membership and signup-fee lines, and only the same gym's plan.
    for (const kind of ['charge', 'discount', 'tax'] as const)
      await expect(maintenance.sql`update invoice_line_items set plan_id = ${planId} where id = ${lineIds[kind]}`)
        .rejects.toEqual(rejected('23514'));
    await expect(maintenance.sql`update invoice_line_items set plan_id = ${foreignPlanId} where id = ${lineIds.membership}`)
      .rejects.toEqual(rejected('23503'));

    // The app role can set every new column under row-level security.
    await database.forGym(gymId, async tx => {
      await tx.update(memberships).set({ scheduledPlanId: otherPlanId, scheduledAmountCents: 9000, scheduledInterval: 'annual',
        scheduledOn: '2026-12-01', switchOverrideReason: 'Moved away' }).where(eq(memberships.id, membershipId));
      for (const id of [lineIds.membership, lineIds.signup_fee])
        await tx.update(invoiceLineItems).set({ planId }).where(eq(invoiceLineItems.id, id));
    });
    expect(await database.forGym(gymId, tx => tx.select().from(memberships))).toEqual([expect.objectContaining({
      scheduledPlanId: otherPlanId, scheduledAmountCents: 9000, scheduledInterval: 'annual', scheduledOn: '2026-12-01',
      switchOverrideReason: 'Moved away',
    })]);
    expect((await database.forGym(gymId, tx => tx.select().from(invoiceLineItems))).filter(line => line.planId === planId)).toHaveLength(2);
    // A scheduled change can be cleared again.
    await database.forGym(gymId, tx => tx.update(memberships).set({ scheduledPlanId: null, scheduledAmountCents: null,
      scheduledInterval: null, scheduledOn: null }).where(eq(memberships.id, membershipId)));
  } finally { await maintenance.close(); }
});
