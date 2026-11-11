// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Reviewed parameterized aggregate over gym-owned tables in the caller's forGym transaction.
import { sql } from 'drizzle-orm';
import { leads, members, type Transaction } from '@plaingym/db';
import type { LeadFunnelResponse } from '@plaingym/shared/contracts';

type FunnelAggregate = LeadFunnelResponse['data']['sources'][number] & Record<string, unknown>;
// PostgreSQL accepts expanded years without ISO's leading plus and zero padding.
const sqlInstant = (instant: Date) => instant.toISOString().replace(/^\+0*/, '');
/** One aggregate statement for any range or cohort size. Erased members remain in the counts. */
export function funnelAggregate(tx: Transaction, gymId: string, startsAt: Date, endsAt: Date) {
  // eslint-disable-next-line database/system-tables -- Reviewed SQL; explicit gym predicates also scope the composite join.
  return tx.execute<FunnelAggregate>(sql`
    select coalesce(l.source, 'unknown') as source, count(*)::integer as leads,
      count(*) filter (where l.trial_attended_at is not null)::integer as "trialAttended",
      count(*) filter (where l.stage = 'won')::integer as won,
      count(*) filter (where l.stage = 'lost')::integer as lost,
      count(*) filter (where coalesce(l.stage, 'new') not in ('won', 'lost'))::integer as open
    from ${members} m
    left join ${leads} l on l.gym_id = ${gymId}::uuid and l.gym_id = m.gym_id and l.member_id = m.id
    where m.gym_id = ${gymId}::uuid and m.created_at >= ${sqlInstant(startsAt)}::timestamptz
      and m.created_at < ${sqlInstant(endsAt)}::timestamptz
      and (l.id is not null or m.status in ('prospect', 'trial'))
    group by coalesce(l.source, 'unknown') order by source
  `);
}
