// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse } from '../../lib/response.js';
import { reportApiRefusal } from '../../lib/api.js';
import {
  attendanceContracts, attendanceTotalsResponseSchema, bookingsContracts,
  memberListResponseSchema, ranksContracts, classTagListResponseSchema,
  type RecordAttendanceRequest, type Member,
} from '@plaingym/shared/contracts';

async function get(path: string, query: Record<string, string | number>) {
  const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  const result = await fetch(`${path}?${params}`, { credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json' } });
  if (!result.ok) { await reportApiRefusal(result); throw new Error('Attendance request failed'); }
  return result.json() as Promise<unknown>;
}
async function catalog<T>(path: string, parse: (value: unknown) => { data: T[]; pagination: { total: number } }) {
  const data: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = parse(await get(path, { limit: 100, offset }));
    data.push(...page.data);
    if (offset + 100 >= page.pagination.total) return data;
  }
}
export const attendanceClient = {
  /** Walk-in suggestions: members who can be checked in, never erased or Cancelled ones. */
  async members(search: string, offset = 0): Promise<Member[]> {
    return parseResponse(memberListResponseSchema, await get('/api/members', { search, checkInEligible: 'true', limit: 50, offset })).data;
  },
  /** Checks whether an attendance record still exists for a member and session. */
  async visitExists(attendanceId: string, memberId: string, sessionId: string): Promise<boolean> {
    attendanceContracts.list.query.parse({ memberId, sessionId, limit: 1, offset: 0 });
    return parseResponse(attendanceContracts.list.response,
      await get(attendanceContracts.list.path, { memberId, sessionId, limit: 1, offset: 0 })).data.some(row => row.id === attendanceId);
  },
  /** The session's eligible roster: booked members, then the waitlist in queue order, then walk-ins. */
  async roster(sessionId: string, offset: number) {
    const params = bookingsContracts.roster.params.parse({ sessionId });
    return parseResponse(bookingsContracts.roster.response,
      await get(bookingsContracts.roster.path.replace('{sessionId}', params.sessionId), { checkInEligible: 'true', limit: 50, offset }));
  },
  async totals(memberId: string) {
    return parseResponse(attendanceTotalsResponseSchema, await get('/api/attendance/totals', { memberId })).data;
  },
  async labels() {
    const [programs, tags] = await Promise.all([
      catalog('/api/programs', (value) => parseResponse(ranksContracts.listPrograms.response, value)),
      catalog('/api/schedule/tags', (value) => parseResponse(classTagListResponseSchema, value)),
    ]);
    return { programs, tags };
  },
  async record(input: RecordAttendanceRequest) {
    const result = await fetch(attendanceContracts.record.path, { method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(attendanceContracts.record.body.parse(input)) });
    if (!result.ok) { await reportApiRefusal(result); throw new Error('Attendance request failed'); }
    return parseResponse(attendanceContracts.record.response, await result.json()).data;
  },
  async undo(id: string) {
    const contract = attendanceContracts.undo;
    const params = contract.params.parse({ id });
    const result = await fetch(contract.path.replace('{id}', params.id), { method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { Accept: 'application/json' } });
    if (!result.ok) { await reportApiRefusal(result); throw new Error('Attendance request failed'); }
    return parseResponse(contract.response, await result.json()).data;
  },
};
