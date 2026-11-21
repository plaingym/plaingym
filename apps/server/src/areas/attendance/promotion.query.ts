// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Isolated parameterized attendance batch under the caller's forGym scope.
import { sql, type SQL } from 'drizzle-orm';
import { attendances, members, type forGym, type Transaction } from '@plaingym/db';
import { predicate } from './attendance.js';

export interface PromotionAttendanceRequest { memberId: string; programId: string; since: string; }
export const promotionAttendanceKey = (request: PromotionAttendanceRequest) => JSON.stringify([request.programId, request.memberId, new Date(request.since).toISOString()]);

// One program scan first won at 75% of the active roster in the dashboard load fixture. The share is now
// measured against distinct visitors, and the load fixture's churn case checks the choice, not the cutoff.
const WHOLE_PROGRAM_CANDIDATE_SHARE = 0.75;

function programWindows(requests: readonly PromotionAttendanceRequest[]) {
  const byProgram = new Map<string, Map<string, PromotionAttendanceRequest>>();
  for (const request of requests) {
    const group = byProgram.get(request.programId) ?? new Map();
    group.set(promotionAttendanceKey(request), request); byProgram.set(request.programId, group);
  }
  return [...byProgram.entries()].map(([programId, group]) => {
    const windows = [...group.values()];
    const earliest = windows.reduce((min, request) => Math.min(min, Date.parse(request.since)), Infinity);
    return { programId, windows, since: new Date(earliest).toISOString() };
  });
}

function scanChoice(gymId: string, windows: readonly PromotionAttendanceRequest[], filter: SQL | undefined) {
  const candidateCount = new Set(windows.map(window => window.memberId)).size;
  const maxVisitors = Math.floor(candidateCount / WHOLE_PROGRAM_CANDIDATE_SHARE);
  // The gym membership count is an upper bound on distinct visitors. If it fits, skip the visit probes.
  // Otherwise look for one matching visit per member and stop once another visitor rules out a scan.
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

function candidateWindows(windows: readonly PromotionAttendanceRequest[]) {
  const json = JSON.stringify(windows.map(request => ({
    member_id: request.memberId, program_id: request.programId, since: request.since,
  })));
  return sql`jsonb_to_recordset(${json}::jsonb) as c(member_id uuid, program_id uuid, since timestamptz)`;
}

function candidateVisitFilter(filter: SQL | undefined) {
  return sql`${filter} and ${attendances.memberId} = c.member_id and ${attendances.occurredAt} >= c.since`;
}

/** Every visit of one program in its earliest window, counted against each candidate window. */
function wholeProgramRead(programId: string, windows: readonly PromotionAttendanceRequest[], filter: SQL | undefined): SQL {
  const programRead = sql`
      select ${attendances.memberId} as member_id,
        ${attendances.occurredAt} as occurred_at, ${programId}::uuid as program_id
      from ${attendances}
    `;
  return sql`with candidates as materialized (
    select * from ${candidateWindows(windows)}
  ), eligible as materialized (${programRead} where ${filter})
    select c.member_id, c.program_id, c.since, count(e.member_id)::integer as total
    from candidates c
    left join eligible e on e.member_id = c.member_id and e.program_id = c.program_id
      and e.occurred_at >= c.since
    group by c.member_id, c.program_id, c.since`;
}

/** One program's part of the promotion statement: the visitor probe and the two reads it chooses between. */
export interface PromotionProgramRead {
  programId: string;
  /** The candidate windows as `c(member_id, program_id, since)`. */
  candidates: SQL;
  /** The attendance predicate for the program's earliest window up to `until`. */
  filter: SQL | undefined;
  /** One row, `scan_program`: true when a whole-program scan is the cheaper read. */
  choice: SQL;
  /** `select` of `(member_id, program_id, since, total)` that scans every visit of the program's earliest window. */
  wholeProgram: SQL;
  /** `select` of `(member_id, program_id, since, total)` for this program, using `choice` to pick a read. */
  read: SQL;
}

/** The statement `countPromotionAttendance` runs, with the per-program fragments it is built from. */
export function promotionAttendanceStatement(tx: Transaction, gymId: string, requests: readonly PromotionAttendanceRequest[],
  until: string, openMatCountsAsClass: boolean): { programs: PromotionProgramRead[]; statement: SQL } {
  const programs = programWindows(requests).map(({ programId, windows, since }): PromotionProgramRead => {
    const filter = predicate(tx, gymId, { programId, since, until, excludeOpenMat: !openMatCountsAsClass });
    const candidates = candidateWindows(windows), choice = scanChoice(gymId, windows, filter);
    const wholeProgram = wholeProgramRead(programId, windows, filter);
    // Count inside each indexed candidate window so a large candidate join need not materialize visit rows.
    const read = sql`(with choice as materialized (${choice})
      select * from (${wholeProgram}) as whole_program
      where (select scan_program from choice)
      union all
      select c.member_id, c.program_id, c.since, totals.total
      from ${candidates}
      cross join lateral (
        select count(*)::integer as total from ${attendances}
        where ${candidateVisitFilter(filter)}
      ) as totals
      where not (select scan_program from choice)
    )`;
    return { programId, candidates, filter, choice, wholeProgram, read };
  });
  const statement = sql`select * from (${sql.join(programs.map(program => program.read), sql` union all `)}) as promotion_counts`;
  return { programs, statement };
}

/** One count per promotion window. Only member and lower-bound correlation belong to the batch;
 * the attendance predicate owns program links, open mat and the exclusive upper bound. */
export async function countPromotionAttendance(scope: typeof forGym, gymId: string, requests: readonly PromotionAttendanceRequest[],
  until: string, openMatCountsAsClass: boolean) {
  if (!requests.length) return new Map<string, number>();
  return scope(gymId, async tx => {
    const read = promotionAttendanceStatement(tx, gymId, requests, until, openMatCountsAsClass).statement;
    // eslint-disable-next-line database/system-tables -- Bound batch read through the caller's gym scope.
    const rows = await tx.execute<{ member_id: string; program_id: string; since: Date | string; total: number }>(read);
    return new Map(rows.map(row => [promotionAttendanceKey({ memberId: row.member_id, programId: row.program_id,
      since: new Date(row.since).toISOString() }), row.total]));
  });
}
