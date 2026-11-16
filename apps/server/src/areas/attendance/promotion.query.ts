// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Isolated parameterized attendance batch under the caller's forGym scope.
import { sql } from 'drizzle-orm';
import { attendances, type forGym } from '@plaingym/db';
import { predicate } from './attendance.js';

export interface PromotionAttendanceRequest { memberId: string; programId: string; since: string; }
export const promotionAttendanceKey = (request: PromotionAttendanceRequest) => JSON.stringify([request.programId, request.memberId, new Date(request.since).toISOString()]);

/** One count per promotion window. Only member and lower-bound correlation belong to the batch;
 * the attendance predicate owns program links, open mat and the exclusive upper bound. */
export async function countPromotionAttendance(scope: typeof forGym, gymId: string, requests: readonly PromotionAttendanceRequest[],
  until: string, openMatCountsAsClass: boolean) {
  const byProgram = new Map<string, Map<string, PromotionAttendanceRequest>>();
  for (const request of requests) {
    const group = byProgram.get(request.programId) ?? new Map();
    group.set(promotionAttendanceKey(request), request); byProgram.set(request.programId, group);
  }
  if (!byProgram.size) return new Map<string, number>();
  return scope(gymId, async tx => {
    const reads = [...byProgram.keys()].map(programId => sql`
      select ${attendances.id} as id, ${attendances.memberId} as member_id,
        ${attendances.occurredAt} as occurred_at, ${programId}::uuid as program_id
      from ${attendances} where ${predicate(tx, gymId, { programId, until, excludeOpenMat: !openMatCountsAsClass })}
    `);
    const candidates = [...byProgram.values()].flatMap(group => [...group.values()]);
    // Filter once per program before joining windows. The program-link subquery inside an OR
    // otherwise makes PostgreSQL repeat the filtered attendance scan for every candidate.
    // eslint-disable-next-line database/system-tables -- Each union arm uses the shared gym-scoped attendance predicate and bound values.
    const rows = await tx.execute<{ member_id: string; program_id: string; since: Date | string; total: number }>(sql`
      with eligible as materialized (${sql.join(reads, sql` union all `)})
      select c.member_id, c.program_id, c.since, count(e.id)::integer as total
      from jsonb_to_recordset(${JSON.stringify(candidates.map(request => ({
        member_id: request.memberId, program_id: request.programId, since: request.since,
      })))}::jsonb) as c(member_id uuid, program_id uuid, since timestamptz)
      left join eligible e on e.member_id = c.member_id and e.program_id = c.program_id and e.occurred_at >= c.since
      group by c.member_id, c.program_id, c.since
    `);
    return new Map(rows.map(row => [promotionAttendanceKey({ memberId: row.member_id, programId: row.program_id,
      since: new Date(row.since).toISOString() }), row.total]));
  });
}
