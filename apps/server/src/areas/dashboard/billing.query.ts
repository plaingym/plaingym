// SPDX-License-Identifier: AGPL-3.0-only
import { lt, ne, or } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Isolated parameterized modulo and dashboard aggregate SQL under forGym.
import { sql } from 'drizzle-orm';
import { invoices, forGym } from '@plaingym/db';
import { terminalDisputeStatuses } from '@plaingym/shared/contracts';
import { minimumChargeAmount, minorUnitStep } from '@plaingym/shared/money';

/** Called within forGym, with an invoice currency filter matching this currency. */
export function skippedAmountCondition(currency: string) {
  const minimum = minimumChargeAmount(currency), step = minorUnitStep(currency);
  return or(lt(invoices.amountCents, minimum ?? 0),
    ne(sql<number>`mod(${invoices.amountCents}, ${step}::integer)`, 0));
}

/** Isolated SQL aggregation, always executed inside the caller's gym RLS transaction. */
export function readBillingTotals(scope: typeof forGym, gymId: string, currency: string, from: string, through: string) {
  // One open-dispute rule for both the relevant set and the disputes total.
  const openDispute = sql`(dispute_id is not null and (dispute_status is null
    or dispute_status not in (${sql.join(terminalDisputeStatuses.map(status => sql`${status}`), sql`, `)})))`;
  return scope(gymId, async tx => {
    // eslint-disable-next-line database/system-tables -- Reviewed aggregate uses gym-owned tables under this scope's forced RLS.
    const [row] = await tx.execute<{
      mrr: string; past_due: string; past_due_count: string; upcoming: string; upcoming_count: string;
      disputes: string; dispute_count: string; mismatch: boolean;
    }>(sql`
      with dues as (
        select * from memberships where gym_id = ${gymId}
          and (status = 'active' or next_due_on <= ${through}::date)
      ), relevant_invoices as (
        select * from invoices where gym_id = ${gymId} and (
          status = 'past_due' or (status = 'open' and due_on < ${from}::date)
          or due_on between ${from}::date and ${through}::date
          or ${openDispute}
        )
      ), estimates as (
        select household_id, next_due_on as due_on, sum(amount_cents)::bigint as amount
        from dues where status in ('active', 'trial') and next_due_on between ${from}::date and ${through}::date
        group by household_id, next_due_on
      ), upcoming as (
        select e.amount from estimates e where not exists (
          select 1 from relevant_invoices i where i.kind = 'cycle' and i.status <> 'draft'
            and i.household_id = e.household_id and i.due_on = e.due_on
        )
        union all
        select amount_cents from relevant_invoices
          where status = 'open' and due_on between ${from}::date and ${through}::date
      ), overdue as (
        select amount_cents from relevant_invoices where amount_cents > 0
          and (status = 'past_due' or (status = 'open' and due_on < ${from}::date))
      ), disputed as (
        select amount_cents from relevant_invoices where ${openDispute}
      )
      select
        (select floor((coalesce(sum(amount_cents::bigint * case when "interval" = 'annual' then 1 else 12 end), 0) + 6) / 12) from dues where status = 'active')::text as mrr,
        (select coalesce(sum(amount_cents), 0) from overdue)::text as past_due,
        (select count(*) from overdue)::text as past_due_count,
        (select coalesce(sum(amount), 0) from upcoming)::text as upcoming,
        (select count(*) from upcoming)::text as upcoming_count,
        (select coalesce(sum(amount_cents), 0) from disputed)::text as disputes,
        (select count(*) from disputed)::text as dispute_count,
        (exists(select 1 from dues where currency <> ${currency})
          or exists(select 1 from relevant_invoices where currency <> ${currency})) as mismatch
    `);
    return row!;
  });
}
