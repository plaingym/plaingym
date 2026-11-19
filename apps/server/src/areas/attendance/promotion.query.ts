// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Isolated parameterized attendance batch under the caller's forGym scope.
import { sql, type SQL } from 'drizzle-orm';
import { attendances, type forGym, type Transaction } from '@plaingym/db';
import { predicate } from './attendance.js';

export interface PromotionAttendanceRequest { memberId: string; programId: string; since: string; }
export const promotionAttendanceKey = (request: PromotionAttendanceRequest) => JSON.stringify([request.programId, request.memberId, new Date(request.since).toISOString()]);

function candidateRows(byProgram: ReadonlyMap<string, ReadonlyMap<string, PromotionAttendanceRequest>>) {
  return [...byProgram.values()].flatMap(group => [...group.values()]);
}

/** The shared CTEs: candidate windows, each member's earliest window per program, and the scoped attendance rows. */
function promotionAttendanceCtes(tx: Transaction, gymId: string, requests: readonly PromotionAttendanceRequest[],
  openMatCountsAsClass: boolean) {
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
    for (const request of group.values()) earliest = Math.min(earliest, Date.parse(request.since));
    const since = new Date(earliest).toISOString();
    const programCandidates = JSON.stringify([...group.values()].map(request => ({
      member_id: request.memberId, program_id: request.programId, since: request.since,
    })));
    // Joining each candidate member's earliest window keeps every other member's rows out of the scan,
    // and the per-member minimum stops a member's second window in the same program from duplicating visits.
    return sql`
      select ${attendances.memberId} as member_id,
        ${attendances.occurredAt} as occurred_at, ${programId}::uuid as program_id
      from ${attendances}
      join (
        select c.member_id, min(c.since) as since
        from jsonb_to_recordset(${programCandidates}::jsonb)
          as c(member_id uuid, program_id uuid, since timestamptz)
        where c.program_id = ${programId}::uuid
        group by c.member_id
      ) c on c.member_id = ${attendances.memberId} and ${attendances.occurredAt} >= c.since
      where ${predicate(tx, gymId, { programId, since, excludeOpenMat: !openMatCountsAsClass })}
    `;
  });
  return sql`with candidates as materialized (
    select * from jsonb_to_recordset(${candidateJson}::jsonb) as c(member_id uuid, program_id uuid, since timestamptz)
  ), eligible as materialized (${sql.join(reads, sql` union all `)})`;
}

/** The batch's one read. Exported so plan tests exercise exactly the SQL that runs. */
export function promotionAttendanceRead(tx: Transaction, gymId: string, requests: readonly PromotionAttendanceRequest[],
  until: string, openMatCountsAsClass: boolean): SQL {
  return sql`${promotionAttendanceCtes(tx, gymId, requests, openMatCountsAsClass)}
    select c.member_id, c.program_id, c.since, count(e.member_id)::integer as total
    from candidates c
    left join eligible e on e.member_id = c.member_id and e.program_id = c.program_id
      and e.occurred_at >= c.since and e.occurred_at < ${until}
    group by c.member_id, c.program_id, c.since`;
}

/** The candidate rows each program arm admitted; a test hook for the CTE the batch counts from. */
export function promotionAttendanceEligibleQuery(tx: Transaction, gymId: string, requests: readonly PromotionAttendanceRequest[],
  until: string, openMatCountsAsClass: boolean): SQL {
  return sql`${promotionAttendanceCtes(tx, gymId, requests, openMatCountsAsClass)}
    select e.member_id, e.occurred_at, e.program_id from eligible e where e.occurred_at < ${until}`;
}

/** One count per promotion window. Only member and lower-bound correlation belong to the batch;
 * the attendance predicate owns program links and open mat, and the outer join owns the exclusive upper bound. */
export async function countPromotionAttendance(scope: typeof forGym, gymId: string, requests: readonly PromotionAttendanceRequest[],
  until: string, openMatCountsAsClass: boolean) {
  if (!requests.length) return new Map<string, number>();
  return scope(gymId, async tx => {
    // eslint-disable-next-line database/system-tables -- One bound batch read through the caller's gym scope.
    const rows = await tx.execute<{ member_id: string; program_id: string; since: Date | string; total: number }>(
      promotionAttendanceRead(tx, gymId, requests, until, openMatCountsAsClass));
    return new Map(rows.map(row => [promotionAttendanceKey({ memberId: row.member_id, programId: row.program_id,
      since: new Date(row.since).toISOString() }), row.total]));
  });
}
