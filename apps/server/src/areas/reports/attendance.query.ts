// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Reviewed parameterized aggregate SQL over gym-owned tables; caller supplies one forGym transaction.
import { sql } from 'drizzle-orm';
import { attendances, classSessionPrograms, programs, type Transaction } from '@plaingym/db';
import type { ReportBucket } from '@plaingym/shared/contracts';
import { sqlInstant } from '@plaingym/shared/time';

export interface AttendanceAggregate extends Record<string, unknown> {
  bucket: number; programId: string | null; programName: string | null; total: number; checkIns: number; uniqueMembers: number;
}
/** A fixed single statement, no timezone conversions or per-bucket round trips. */
export function attendanceAggregate(tx: Transaction, gymId: string, buckets: readonly ReportBucket[]) {
  const boundaries = JSON.stringify(buckets.map((bucket, index) => ({ bucket: index,
    start: sqlInstant(new Date(bucket.startsAt)), end: sqlInstant(new Date(bucket.endsAt)) })));
  // eslint-disable-next-line database/system-tables -- The one reviewed aggregate statement; only gym-owned tables, all filtered by gym_id.
  return tx.execute<AttendanceAggregate>(sql`
    with boundaries as (
      select * from jsonb_to_recordset(${boundaries}::jsonb) as b(bucket integer, start timestamptz, "end" timestamptz)
    ), visits as materialized (
      select id, member_id, session_id, program_id,
        width_bucket(occurred_at, array(select start from boundaries order by bucket)) - 1 as bucket
      from ${attendances}
      where gym_id = ${gymId}::uuid and occurred_at >= ${sqlInstant(new Date(buckets[0]!.startsAt))}::timestamptz
        and occurred_at < ${sqlInstant(new Date(buckets.at(-1)!.endsAt))}::timestamptz
    ), bucket_visits as (
      select b.bucket, a.id, a.member_id, links.program_id, p.name as program_name
      from boundaries b
      left join visits a on a.bucket = b.bucket
      left join lateral (
        select a.program_id where a.program_id is not null
        union
        select sp.program_id from ${classSessionPrograms} sp where sp.gym_id = ${gymId}::uuid and sp.session_id = a.session_id
      ) links on true
      left join ${programs} p on p.gym_id = ${gymId}::uuid and p.id = links.program_id
    )
    select bucket, program_id as "programId", program_name as "programName", grouping(program_id)::integer as total,
      count(distinct id)::integer as "checkIns", count(distinct member_id)::integer as "uniqueMembers"
    from bucket_visits
    group by grouping sets ((bucket, program_id, program_name), (bucket))
    order by bucket, total desc, program_name, program_id
  `);
}
