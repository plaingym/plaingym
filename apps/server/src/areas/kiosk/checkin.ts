// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, inArray, lte } from 'drizzle-orm';
import { classBookings, classSessions, forGym } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import type { KioskCheckinResult, KioskMemberIdentity, KioskSessionChoice } from '@plaingym/shared/contracts';
import type { Uploads } from '../../infra/storage/index.js';
import { createAttendanceService } from '../attendance/attendance.js';

/** Sessions open for check-in this long before they start, and until they end. */
export const checkinOpensBeforeMs = 60 * 60_000;
const photoUrlSeconds = 300;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export type KioskMemberRow = { id: string; firstName: string; lastName: string; photoKey: string | null };

/** Shared privacy, session selection and attendance rules for PIN and QR check-in. */
export function createKioskCheckinHelpers(options: {
  scope: typeof forGym; clock: Clock; uploadsFor?: (gymId: string) => Promise<Uploads>;
}) {
  const { scope, clock } = options;
  const attendance = createAttendanceService({ scope, clock });
  /** First name, last initial and a short-lived photo link: nothing else reaches the shared screen. */
  async function identities(gymId: string, rows: readonly KioskMemberRow[]): Promise<Map<string, KioskMemberIdentity>> {
    const uploads = options.uploadsFor && rows.some((row) => row.photoKey) ? await options.uploadsFor(gymId).catch(() => undefined) : undefined;
    const result = new Map<string, KioskMemberIdentity>();
    for (const row of rows) {
      const photoUrl = uploads && row.photoKey ? await uploads.signedUrl(row.photoKey, photoUrlSeconds).catch(() => null) : null;
      const lastInitial = segmenter.segment(row.lastName.trim()).containing(0)?.segment ?? '?';
      result.set(row.id, { id: row.id, firstName: row.firstName, lastInitial, photoUrl });
    }
    return result;
  }
  async function currentSessions(gymId: string): Promise<KioskSessionChoice[]> {
    const now = clock.now();
    const rows = await scope(gymId, (tx) => tx.select({ id: classSessions.id, name: classSessions.name, startsAt: classSessions.startsAt, endsAt: classSessions.endsAt })
      .from(classSessions).where(and(eq(classSessions.status, 'scheduled'), lte(classSessions.startsAt, new Date(now.getTime() + checkinOpensBeforeMs)), gt(classSessions.endsAt, now)))
      .orderBy(asc(classSessions.startsAt), asc(classSessions.id)));
    return rows.map((row) => ({ ...row, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString() }));
  }
  async function bookedSessions(gymId: string, memberIds: readonly string[], sessionIds: readonly string[]) {
    if (!memberIds.length || !sessionIds.length) return [];
    return scope(gymId, (tx) => tx.select({ memberId: classBookings.memberId, sessionId: classBookings.sessionId }).from(classBookings)
      .where(and(eq(classBookings.status, 'booked'), inArray(classBookings.memberId, [...memberIds]), inArray(classBookings.sessionId, [...sessionIds]))));
  }
  async function record(gymId: string, deviceId: string, member: KioskMemberIdentity, sessionId: string | null): Promise<KioskCheckinResult> {
    try {
      // Open mat is never deduplicated; a session check-in reports an earlier one instead of recording again.
      // References can disappear after selection; the lookup must stay inside the neutral error boundary too.
      if (sessionId && (await attendance.list(gymId, { memberId: member.id, sessionId, limit: 1, offset: 0 })).pagination.total)
        return { status: 'already_checked_in', member };
      await attendance.record({ gymId, actor: { kind: 'device', deviceId } }, { memberId: member.id, sessionId, programId: null }, { source: 'kiosk' });
    } catch (error) {
      if (error instanceof AppError && (error.code === 'conflict' || error.code === 'not_found')) return { status: 'see_front_desk' };
      throw error;
    }
    return { status: 'checked_in', member };
  }

  return { identities, currentSessions, bookedSessions, record };
}
