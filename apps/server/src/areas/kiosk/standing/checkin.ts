// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, ilike, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { classBookings, classSessions, forGym, households, members } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import {
  kioskLookupRequestSchema, kioskNamePinCheckinRequestSchema,
  type KioskCheckinResult, type KioskLookupResponse, type KioskMemberIdentity, type KioskSessionChoice, type KioskStanding,
} from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../../core/clock.js';
import type { Uploads } from '../../../infra/storage/index.js';
import { createAttendanceService } from '../../attendance/attendance.js';
import { verifyHouseholdPin, type HouseholdPinSecret } from '../../members/pin.js';
import { createBillingStanding } from '../../billing/kiosk-standing.js';
import { createStandingChecks, inactiveStanding, waiverStanding, type StandingChecks } from './standing.js';

/** Sessions open for check-in this long before they start, and until they end. */
export const checkinOpensBeforeMs = 60 * 60_000;
/** Bounds the PIN comparisons one search can trigger; more matching households need the front desk. */
const maxCandidateHouseholds = 25;
const photoUrlSeconds = 300;
const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface KioskCheckinOptions {
  scope?: typeof forGym; clock?: Clock; standing?: StandingChecks;
  /** The gym's random key (`areas/settings/gym-keys.ts`); without it, PIN lookups fail closed. */
  pinSecret?: HouseholdPinSecret;
  /** Photo storage for short-lived photo links; without it, identities carry no photo. */
  uploadsFor?: (gymId: string) => Promise<Uploads>;
}
type MemberRow = { id: string; firstName: string; lastName: string; photoKey: string | null };

export function createKioskCheckin(options: KioskCheckinOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const standing = options.standing ?? createStandingChecks([inactiveStanding(scope), waiverStanding(scope), createBillingStanding(scope)]);
  const attendance = createAttendanceService({ scope, clock });

  /** The one household whose PIN matches among households with a member or household name matching the search. */
  async function findHousehold(gymId: string, name: string, pin: string): Promise<string | null> {
    if (!options.pinSecret) throw new AppError('unavailable', 'Kiosk PIN check-in is not configured');
    const text = name.trim().replace(/\s+/g, ' '), [first, ...rest] = text.split(' ');
    const prefix = (value: string) => escapeLike(value) + '%';
    const candidates = await scope(gymId, (tx) => tx.selectDistinct({ id: households.id, pinHash: households.pinHash })
      .from(members).innerJoin(households, eq(households.id, members.householdId))
      .where(and(isNull(members.anonymizedAt), isNotNull(households.pinHash), or(
        ilike(members.firstName, prefix(text)), ilike(members.lastName, prefix(text)), ilike(households.name, '%' + escapeLike(text) + '%'),
        rest.length ? and(ilike(members.firstName, prefix(first!)), ilike(members.lastName, prefix(rest.join(' ')))) : undefined,
      ))).limit(maxCandidateHouseholds + 1));
    if (!candidates.length || candidates.length > maxCandidateHouseholds) return null;
    const secret = await options.pinSecret(gymId);
    const matches = candidates.filter((row) => verifyHouseholdPin(secret, gymId, row.id, pin, row.pinHash));
    // Two households sharing a name and PIN can't be told apart: never guess.
    return matches.length === 1 ? matches[0]!.id : null;
  }
  async function householdMembers(gymId: string, householdId: string): Promise<MemberRow[]> {
    return scope(gymId, (tx) => tx.select({ id: members.id, firstName: members.firstName, lastName: members.lastName, photoKey: members.photoKey })
      .from(members).where(and(eq(members.householdId, householdId), isNull(members.anonymizedAt)))
      .orderBy(asc(members.firstName), asc(members.id)));
  }
  /** First name, last initial and a short-lived photo link: nothing else reaches the shared screen. */
  async function identities(gymId: string, rows: readonly MemberRow[]): Promise<Map<string, KioskMemberIdentity>> {
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

  return {
    async lookup(gymId: string, input: unknown, pinVerified?: () => void): Promise<KioskLookupResponse['data']> {
      const { name, pin } = kioskLookupRequestSchema.parse(input);
      const householdId = await findHousehold(gymId, name, pin);
      if (householdId) pinVerified?.();
      const rows = householdId ? await householdMembers(gymId, householdId) : [];
      if (!rows.length) return { status: 'see_front_desk' };
      const people = await identities(gymId, rows);
      return { status: 'select_member', members: rows.map((row) => people.get(row.id)!) };
    },
    /** Rechecks the name and PIN on every submission; results keep the order of the selections. */
    async checkin(gymId: string, deviceId: string, input: unknown, pinVerified?: () => void): Promise<KioskCheckinResult[]> {
      const { name, pin, checkins } = kioskNamePinCheckinRequestSchema.parse(input);
      const householdId = await findHousehold(gymId, name, pin);
      if (householdId) pinVerified?.();
      const rows = householdId ? await householdMembers(gymId, householdId) : [];
      const people = await identities(gymId, rows.filter((row) => checkins.some((item) => item.memberId === row.id)));
      const sessions = await currentSessions(gymId);
      const bookings = await bookedSessions(gymId, [...people.keys()], sessions.map((session) => session.id));
      const results: KioskCheckinResult[] = [];
      for (const { memberId, sessionId } of checkins) {
        const member = people.get(memberId);
        // Members outside the PIN's household get the same neutral answer as standing problems.
        if (!member || (await standing.evaluate({ gymId, memberId, clock })).status !== 'ok') { results.push({ status: 'see_front_desk' }); continue; }
        if (sessionId === null) { results.push(await record(gymId, deviceId, member, null)); continue; }
        if (sessionId !== undefined) {
          results.push(sessions.some((session) => session.id === sessionId)
            ? await record(gymId, deviceId, member, sessionId) : { status: 'select_session', member, sessions });
          continue;
        }
        const booked = sessions.filter((session) => bookings.some((booking) => booking.memberId === memberId && booking.sessionId === session.id));
        results.push(booked.length === 1 ? await record(gymId, deviceId, member, booked[0]!.id)
          : { status: 'select_session', member, sessions: booked.length ? booked : sessions });
      }
      return results;
    },
    /** Staff view of why the kiosk would send a member to the front desk. */
    async memberStanding(gymId: string, memberId: string): Promise<KioskStanding> {
      const [row] = await scope(gymId, (tx) => tx.select({ id: members.id }).from(members).where(eq(members.id, memberId)));
      if (!row) throw new AppError('not_found', 'Resource not found');
      const result = await standing.evaluate({ gymId, memberId, clock });
      return { memberId, status: result.status, reasons: [...result.reasons] };
    },
  };
}
export type KioskCheckin = ReturnType<typeof createKioskCheckin>;
