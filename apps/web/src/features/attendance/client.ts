// SPDX-License-Identifier: AGPL-3.0-only
import {
  attendanceContracts, attendanceListResponseSchema, attendanceTotalsResponseSchema,
  memberListResponseSchema, ranksContracts, classTagListResponseSchema,
  type RecordAttendanceRequest, type Attendance, type Member,
} from '@plaingym/shared/contracts';

async function get(path: string, query: Record<string, string | number>) {
  const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  const result = await fetch(`${path}?${params}`, { credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json' } });
  if (!result.ok) throw new Error('Attendance request failed');
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
  async members(search: string, offset: number): Promise<{ data: Member[]; total: number }> {
    const page = memberListResponseSchema.parse(await get('/api/members', { limit: 50, offset, ...(search ? { search } : {}) }));
    return { data: page.data, total: page.pagination.total };
  },
  async checkedIn(sessionId: string) {
    const data: Attendance[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = attendanceListResponseSchema.parse(await get('/api/attendance', { sessionId, limit: 100, offset }));
      data.push(...page.data);
      if (offset + 100 >= page.pagination.total) return data;
    }
  },
  async totals(memberId: string) {
    return attendanceTotalsResponseSchema.parse(await get('/api/attendance/totals', { memberId })).data;
  },
  async labels() {
    const [programs, tags] = await Promise.all([
      catalog('/api/programs', (value) => ranksContracts.listPrograms.response.parse(value)),
      catalog('/api/schedule/tags', (value) => classTagListResponseSchema.parse(value)),
    ]);
    return { programs, tags };
  },
  async record(input: RecordAttendanceRequest) {
    const result = await fetch(attendanceContracts.record.path, { method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(attendanceContracts.record.body.parse(input)) });
    if (!result.ok) throw new Error('Attendance request failed');
    return attendanceContracts.record.response.parse(await result.json()).data;
  },
};
