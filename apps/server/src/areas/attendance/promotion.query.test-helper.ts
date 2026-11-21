// SPDX-License-Identifier: AGPL-3.0-only
// Test-only views of the promotion attendance statement, built from the fragments countPromotionAttendance runs.
// eslint-disable-next-line database/system-tables -- Composes the scoped promotion fragments; callers run it under forGym.
import { sql, type SQL } from 'drizzle-orm';
import { attendances, type Transaction } from '@plaingym/db';
import { promotionAttendanceStatement, type PromotionAttendanceRequest } from './promotion.query.js';

/** `(program_id, scan_program)`: the per-program read the statement picks. */
export function promotionAttendanceScanChoices(tx: Transaction, gymId: string, requests: readonly PromotionAttendanceRequest[],
  until: string, openMatCountsAsClass: boolean): SQL {
  const { programs } = promotionAttendanceStatement(tx, gymId, requests, until, openMatCountsAsClass);
  return sql.join(programs.map(({ programId, choice }) =>
    sql`select ${programId}::uuid as program_id, scan_program from (${choice}) as choice`), sql` union all `);
}

/**
 * One read forced for every program, for plan comparisons in the load fixture: `whole_program` is the
 * statement's own whole-program arm; `candidate_join` joins each candidate's earliest window to the
 * program's visits, the read the statement replaced, kept only as a timing baseline.
 */
export function promotionAttendanceForcedRead(tx: Transaction, gymId: string, requests: readonly PromotionAttendanceRequest[],
  until: string, openMatCountsAsClass: boolean, plan: 'whole_program' | 'candidate_join'): SQL {
  const { programs } = promotionAttendanceStatement(tx, gymId, requests, until, openMatCountsAsClass);
  const reads = programs.map(({ candidates, filter, wholeProgram }) => plan === 'whole_program'
    ? sql`select * from (${wholeProgram}) as whole_program`
    : sql`select * from (with eligible as materialized (
        select ${attendances.memberId} as member_id, ${attendances.occurredAt} as occurred_at
        from ${attendances}
        join (select c.member_id, min(c.since) as since from ${candidates} group by c.member_id) c
          on c.member_id = ${attendances.memberId} and ${attendances.occurredAt} >= c.since
        where ${filter}
      )
      select c.member_id, c.program_id, c.since, count(e.member_id)::integer as total
      from ${candidates}
      left join eligible e on e.member_id = c.member_id and e.occurred_at >= c.since
      group by c.member_id, c.program_id, c.since) as candidate_join`);
  return sql`select * from (${sql.join(reads, sql` union all `)}) as promotion_counts`;
}
