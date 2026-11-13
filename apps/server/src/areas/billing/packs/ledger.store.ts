// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Reviewed SQL: parameterized advisory key and scoped ledger-only expiry query below.
import { sql } from 'drizzle-orm';
import { classCreditEntries, type Transaction } from '@plaingym/db';

/** Serializes one gym's command across members, before any member lock is taken. */
export async function lockAdjustment(tx: Transaction, gymId: string, adjustmentId: string) {
  // eslint-disable-next-line database/system-tables -- Transaction-scoped lock only; no table or unscoped connection access.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`class-credit-adjustment:${gymId}:${adjustmentId}`}, 0))`);
}

/** Openings use the expiry index; movements are scoped to the same gym, member and lot. */
export async function expiryCandidates(tx: Transaction, cutoff: Date, cursor?: string) {
  // eslint-disable-next-line database/system-tables -- Reviewed correlated ledger sum; runs only on the caller's forGym transaction with forced RLS.
  return tx.execute<{ memberId: string }>(sql`
    select distinct opening.member_id as "memberId"
    from ${classCreditEntries} opening
    where opening.lot_id is null and opening.expires_at <= ${cutoff.toISOString()}::timestamptz
      and (${cursor ?? null}::uuid is null or opening.member_id > ${cursor ?? null}::uuid)
      and not exists (select 1 from ${classCreditEntries} movement
        where movement.gym_id = opening.gym_id and movement.member_id = opening.member_id
          and movement.lot_id = opening.id and movement.kind = 'expire')
      and opening.credits + coalesce((select sum(movement.credits) from ${classCreditEntries} movement
        where movement.gym_id = opening.gym_id and movement.member_id = opening.member_id
          and movement.lot_id = opening.id), 0) > 0
    order by opening.member_id limit 100
  `);
}
