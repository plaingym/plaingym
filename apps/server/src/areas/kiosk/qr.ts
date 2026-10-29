// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull } from 'drizzle-orm';
import { forGym, members } from '@plaingym/db';
import { type Clock } from '@plaingym/shared';
import { kioskQrCheckinRequestSchema, type KioskCheckinResult } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import { createCheckinCodeService, type CheckinCodeService } from '../members/checkin-code.js';
import { createBillingStanding } from '../billing/kiosk-standing.js';
import type { Uploads } from '../../infra/storage/index.js';
import { createKioskCheckinHelpers } from './checkin.js';
import { createStandingChecks, inactiveStanding, waiverStanding, type StandingChecks } from './standing/standing.js';

export interface QrCheckinOptions {
  scope?: typeof forGym; clock?: Clock; codes?: CheckinCodeService; standing?: StandingChecks;
  uploadsFor?: (gymId: string) => Promise<Uploads>;
}
export function createQrCheckin(options: QrCheckinOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const codes = options.codes ?? createCheckinCodeService({ scope, clock });
  const { identities, currentSessions, bookedSessions, record } = createKioskCheckinHelpers({ ...options, scope, clock });
  const standing = options.standing ?? createStandingChecks([inactiveStanding(scope), waiverStanding(scope), createBillingStanding(scope)]);
  return {
    async checkin(gymId: string, deviceId: string, input: unknown): Promise<KioskCheckinResult> {
      const { code, sessionId } = kioskQrCheckinRequestSchema.parse(input);
      const memberId = await codes.resolve(gymId, code);
      if (!memberId || (await standing.evaluate({ gymId, memberId, clock })).status !== 'ok') return { status: 'see_front_desk' };
      const [row] = await scope(gymId, (tx) => tx.select({ id: members.id, firstName: members.firstName, lastName: members.lastName, photoKey: members.photoKey })
        .from(members).where(and(eq(members.id, memberId), isNull(members.anonymizedAt))));
      if (!row) return { status: 'see_front_desk' };
      const member = (await identities(gymId, [row])).get(memberId)!;
      const sessions = await currentSessions(gymId);
      let selected = sessionId;
      if (selected === undefined) {
        const bookings = await bookedSessions(gymId, [memberId], sessions.map((session) => session.id));
        const booked = sessions.filter((session) => bookings.some((booking) => booking.sessionId === session.id));
        if (booked.length !== 1) return { status: 'select_session', member, sessions: booked.length ? booked : sessions };
        selected = booked[0]!.id;
      }
      if (selected !== null && !sessions.some((session) => session.id === selected)) return { status: 'select_session', member, sessions };
      // Every selection reauthenticates the QR; a cached picker never grants continuing access after reset.
      if (await codes.resolve(gymId, code) !== memberId) return { status: 'see_front_desk' };
      return record(gymId, deviceId, member, selected);
    },
  };
}
export type QrCheckin = ReturnType<typeof createQrCheckin>;
