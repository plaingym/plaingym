// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Isolated parameterized attendance batch under the caller's forGym scope.
import { sql, type SQL } from 'drizzle-orm';
import { attendances, type forGym, type Transaction } from '@plaingym/db';
import { predicate } from './attendance.js';

export interface PromotionAttendanceRequest { memberId: string; programId: string; since: string; }
export const promotionAttendanceKey = (request: PromotionAttendanceRequest) => JSON.stringify([request.programId, request.memberId, new Date(request.since).toISOString()]);

// Measured on CI with the 1,000-member dashboard load fixture: the candidate join was faster at 10%, 25%
// and 50% of the roster, and one program scan first won at 75%.
const WHOLE_PROGRAM_CANDIDATE_SHARE = 0.75;

function candidateRows(byProgram: ReadonlyMap<string, ReadonlyMap<string, PromotionAttendanceRequest>>) {
  return [...byProgram.values()].flatMap(group => [...group.values()]);
}

/** Candidate windows and one filtered attendance read per program. */
function promotionAttendanceCtes(tx: Transaction, gymId: string, requests: readonly PromotionAttendanceRequest[],
  until: string, openMatCountsAsClass: boolean, activeRosterSize?: number) {
  const byProgram = new Map<string, Map<string, PromotionAttendanceRequest>>();
  for (const request of requests) {
    const group = byProgram.get(request.programId) ?? new Map();
    group.set(promotionAttendanceKey(request), request); byProgram.set(request.programId, group);
  }
  const candidates = candidateRows(byProgram);
  const candidateJson = JSON.stringify(candidates.map(request => ({
    member_id: request.memberId, program_id: request.programId, since: request.since,
  })));
  const reads = [...byProgram.entries()].map(([programId, group]) => {
    // Each arm starts at its group's earliest window; the outer join applies each candidate's own bound.
    let earliest = Infinity;
    const candidateMembers = new Set<string>();
    for (const request of group.values()) {
      earliest = Math.min(earliest, Date.parse(request.since));
      candidateMembers.add(request.memberId);
    }
    const since = new Date(earliest).toISOString();
    const scanProgram = activeRosterSize !== undefined
      && candidateMembers.size >= activeRosterSize * WHOLE_PROGRAM_CANDIDATE_SHARE;
    const filter = predicate(tx, gymId, { programId, since, until, excludeOpenMat: !openMatCountsAsClass });
    const programRead = sql`
      select ${attendances.memberId} as member_id,
        ${attendances.occurredAt} as occurred_at, ${programId}::uuid as program_id
      from ${attendances}
    `;
    if (scanProgram) return sql`${programRead} where ${filter}`;

    const programCandidates = JSON.stringify([...group.values()].map(request => ({
      member_id: request.memberId, program_id: request.programId, since: request.since,
    })));
    // Joining each candidate member's earliest window keeps every other member's rows out of the scan,
    // and the per-member minimum stops a member's second window in the same program from duplicating visits.
    return sql`${programRead}
      join (
        select c.member_id, min(c.since) as since
        from jsonb_to_recordset(${programCandidates}::jsonb)
          as c(member_id uuid, program_id uuid, since timestamptz)
        where c.program_id = ${programId}::uuid
        group by c.member_id
      ) c on c.member_id = ${attendances.memberId} and ${attendances.occurredAt} >= c.since
      where ${filter}
    `;
  });
  return sql`with candidates as materialized (
    select * from jsonb_to_recordset(${candidateJson}::jsonb) as c(member_id uuid, program_id uuid, since timestamptz)
  ), eligible as materialized (${sql.join(reads, sql` union all `)})`;
}

/** The batch's one read. Exported so plan tests exercise exactly the SQL that runs. */
export function promotionAttendanceRead(tx: Transaction, gymId: string, requests: readonly PromotionAttendanceRequest[],
  until: string, openMatCountsAsClass: boolean, activeRosterSize?: number): SQL {
  return sql`${promotionAttendanceCtes(tx, gymId, requests, until, openMatCountsAsClass, activeRosterSize)}
    select c.member_id, c.program_id, c.since, count(e.member_id)::integer as total
    from candidates c
    left join eligible e on e.member_id = c.member_id and e.program_id = c.program_id
      and e.occurred_at >= c.since
    group by c.member_id, c.program_id, c.since`;
}

/** The candidate rows each program arm admitted; a test hook for the CTE the batch counts from. */
export function promotionAttendanceEligibleQuery(tx: Transaction, gymId: string, requests: readonly PromotionAttendanceRequest[],
  until: string, openMatCountsAsClass: boolean): SQL {
  return sql`${promotionAttendanceCtes(tx, gymId, requests, until, openMatCountsAsClass)}
    select e.member_id, e.occurred_at, e.program_id from eligible e`;
}

/** One count per promotion window. Only member and lower-bound correlation belong to the batch;
 * the attendance predicate owns program links, open mat and the exclusive upper bound. */
export async function countPromotionAttendance(scope: typeof forGym, gymId: string, requests: readonly PromotionAttendanceRequest[],
  until: string, openMatCountsAsClass: boolean, activeRosterSize?: number) {
  if (!requests.length) return new Map<string, number>();
  return scope(gymId, async tx => {
    // eslint-disable-next-line database/system-tables -- One bound batch read through the caller's gym scope.
    const rows = await tx.execute<{ member_id: string; program_id: string; since: Date | string; total: number }>(
      promotionAttendanceRead(tx, gymId, requests, until, openMatCountsAsClass, activeRosterSize));
    return new Map(rows.map(row => [promotionAttendanceKey({ memberId: row.member_id, programId: row.program_id,
      since: new Date(row.since).toISOString() }), row.total]));
  });
}
