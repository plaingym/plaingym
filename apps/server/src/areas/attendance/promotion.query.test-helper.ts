// SPDX-License-Identifier: AGPL-3.0-only
// Test-only views of the promotion attendance statement, built from the fragments countPromotionAttendance runs.
// eslint-disable-next-line database/system-tables -- Composes the scoped promotion fragments; callers run it under forGym.
import { sql, type SQL } from 'drizzle-orm';
import { attendances, members, type Transaction } from '@plaingym/db';
import { promotionAttendanceStatement, type PromotionAttendanceRequest } from './promotion.query.js';

/**
 * The visitor probe before the member cap, kept only as a timing baseline. A gym with more members than the
 * probe limit used to walk the whole roster here; the baseline still does, so the load fixture can price it.
 */
function exactProbeChoice(gymId: string, windows: readonly PromotionAttendanceRequest[], filter: SQL | undefined) {
  const candidateCount = new Set(windows.map(window => window.memberId)).size;
  const maxVisitors = Math.floor(candidateCount / 0.75);
  return sql`select case when not exists (
      select 1 from ${members} where ${members.gymId} = ${gymId} offset ${maxVisitors}
    ) then true else not exists (
      select 1 from ${members}
      where ${members.gymId} = ${gymId} and (
        select true from ${attendances}
        where ${filter} and ${attendances.memberId} = ${members.id}
        limit 1
      )
      offset ${maxVisitors}
    ) end as scan_program`;
}

/** `(program_id, scan_program)` from the uncapped probe, for the load fixture's baseline plan check. */
export function promotionAttendanceExactProbeChoices(tx: Transaction, gymId: string, requests: readonly PromotionAttendanceRequest[],
  until: string, openMatCountsAsClass: boolean): SQL {
  const { programs } = promotionAttendanceStatement(tx, gymId, requests, until, openMatCountsAsClass);
  return sql.join(programs.map(({ programId, filter }) =>
    sql`select ${programId}::uuid as program_id, scan_program from (${exactProbeChoice(gymId,
      requests.filter(request => request.programId === programId), filter)}) as choice`), sql` union all `);
}

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
 * program's visits, the read the statement replaced, kept only as a timing baseline. `exact_probe` is the
 * statement before the member cap: the uncapped probe still chooses between `whole_program` and
 * `candidateRead`.
 */
export function promotionAttendanceForcedRead(tx: Transaction, gymId: string, requests: readonly PromotionAttendanceRequest[],
  until: string, openMatCountsAsClass: boolean, plan: 'exact_probe' | 'whole_program' | 'candidate_join'): SQL {
  const { programs } = promotionAttendanceStatement(tx, gymId, requests, until, openMatCountsAsClass);
  const reads = programs.map(({ programId, candidates, filter, wholeProgram, candidateRead }) => {
    if (plan === 'exact_probe') {
      const choice = exactProbeChoice(gymId, requests.filter(request => request.programId === programId), filter);
      return sql`(with choice as materialized (${choice})
        select * from (${wholeProgram}) as whole_program
        where (select scan_program from choice)
        union all
        ${candidateRead}
        where not (select scan_program from choice))`;
    }
    return plan === 'whole_program'
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
      group by c.member_id, c.program_id, c.since) as candidate_join`;
  });
  return sql`select * from (${sql.join(reads, sql` union all `)}) as promotion_counts`;
}
