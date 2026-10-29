// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, isNull, lte } from 'drizzle-orm';
import { classSessions, forGym, members } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { kioskQrCheckinRequestSchema, type KioskCheckinResult, type KioskMemberIdentity } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import { createAttendanceService } from '../attendance/attendance.js';
import { createCheckinCodeService, type CheckinCodeService } from '../members/checkin-code.js';
import { createBillingStanding } from '../billing/kiosk-standing.js';
import type { Uploads } from '../../infra/storage/index.js';
import { checkinOpensBeforeMs } from './standing/checkin.js';
import { createStandingChecks, inactiveStanding, waiverStanding, type StandingChecks } from './standing/standing.js';

export interface QrCheckinOptions {
  scope?: typeof forGym; clock?: Clock; codes?: CheckinCodeService; standing?: StandingChecks;
  uploadsFor?: (gymId: string) => Promise<Uploads>;
  /** D1.2 adapter returns booked session IDs; cancelled and waitlisted places never qualify. */
  bookedSessions?: (gymId: string, memberId: string, sessionIds: readonly string[]) => Promise<readonly string[]>;
}
export function createQrCheckin(options: QrCheckinOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const codes = options.codes ?? createCheckinCodeService({ scope, clock });
  const attendance = createAttendanceService({ scope, clock });
  const standing = options.standing ?? createStandingChecks([inactiveStanding(scope), waiverStanding(scope), createBillingStanding(scope)]);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return {
    async checkin(gymId: string, deviceId: string, input: unknown): Promise<KioskCheckinResult> {
      const { code, sessionId } = kioskQrCheckinRequestSchema.parse(input);
      const memberId = await codes.resolve(gymId, code);
      if (!memberId || (await standing.evaluate({ gymId, memberId, clock })).status !== 'ok') return { status: 'see_front_desk' };
      const [row] = await scope(gymId, (tx) => tx.select({ firstName: members.firstName, lastName: members.lastName, photoKey: members.photoKey })
        .from(members).where(and(eq(members.id, memberId), isNull(members.anonymizedAt))));
      if (!row) return { status: 'see_front_desk' };
      const photoUrl = row.photoKey && options.uploadsFor ? await options.uploadsFor(gymId)
        .then((uploads) => uploads.signedUrl(row.photoKey!, 300)).catch(() => null) : null;
      const member: KioskMemberIdentity = { id: memberId, firstName: row.firstName,
        lastInitial: segmenter.segment(row.lastName.trim()).containing(0)?.segment ?? '?', photoUrl };
      const now = clock.now();
      const rows = await scope(gymId, (tx) => tx.select({ id: classSessions.id, name: classSessions.name, startsAt: classSessions.startsAt, endsAt: classSessions.endsAt })
        .from(classSessions).where(and(eq(classSessions.status, 'scheduled'), lte(classSessions.startsAt, new Date(now.getTime() + checkinOpensBeforeMs)), gt(classSessions.endsAt, now)))
        .orderBy(asc(classSessions.startsAt), asc(classSessions.id)));
      const sessions = rows.map((session) => ({ ...session, startsAt: session.startsAt.toISOString(), endsAt: session.endsAt.toISOString() }));
      let selected = sessionId;
      if (selected === undefined) {
        // TODO(D1.2): runtime injects the booking service adapter once its implementation lands.
        const bookedIds = options.bookedSessions ? await options.bookedSessions(gymId, memberId, sessions.map((session) => session.id)) : [];
        const booked = sessions.filter((session) => bookedIds.includes(session.id));
        if (booked.length !== 1) return { status: 'select_session', member, sessions: booked.length ? booked : sessions };
        selected = booked[0]!.id;
      }
      if (selected !== null && !sessions.some((session) => session.id === selected)) return { status: 'select_session', member, sessions };
      // Every selection reauthenticates the QR; a cached picker never grants continuing access after reset.
      if (await codes.resolve(gymId, code) !== memberId) return { status: 'see_front_desk' };
      try {
        if (selected && (await attendance.list(gymId, { memberId, sessionId: selected, limit: 1, offset: 0 })).pagination.total)
          return { status: 'already_checked_in', member };
        await attendance.record({ gymId, actor: { kind: 'device', deviceId } }, { memberId, sessionId: selected, programId: null }, { source: 'kiosk' });
        return { status: 'checked_in', member };
      } catch (error) {
        if (error instanceof AppError && (error.code === 'not_found' || error.code === 'conflict')) return { status: 'see_front_desk' };
        throw error;
      }
    },
  };
}
export type QrCheckin = ReturnType<typeof createQrCheckin>;
