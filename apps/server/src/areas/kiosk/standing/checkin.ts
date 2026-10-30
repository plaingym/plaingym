// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, ilike, isNotNull, isNull, or } from 'drizzle-orm';
import { forGym, households, members } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import {
  kioskLookupRequestSchema, kioskNamePinCheckinRequestSchema,
  type KioskCheckinResult, type KioskLookupResponse, type KioskStanding,
} from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../../core/clock.js';
import type { Uploads } from '../../../infra/storage/index.js';
import { createKioskCheckinHelpers, type KioskMemberRow } from '../checkin.js';
import type { KioskPinCheck } from '../devices.auth.js';
import { verifyHouseholdPin, type HouseholdPinSecret } from '../../members/pin.js';
import { createBillingStanding } from '../../billing/kiosk-standing.js';
import { createStandingChecks, inactiveStanding, waiverStanding, type StandingChecks } from './standing.js';

export { checkinOpensBeforeMs } from '../checkin.js';
/**
 * Bounds the households one PIN guess is checked against, so a guess can't land in whichever of many matching
 * households shares it. A wider match goes to the front desk; a first and last name narrows a common surname.
 */
export const maxCandidateHouseholds = 3;
/** Hears what one PIN guess came to; the kiosk limiter spends budget only on wrong PINs (`devices.auth.ts`). */
export type PinChecked = (check: KioskPinCheck) => void;
const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

export interface KioskCheckinOptions {
  scope?: typeof forGym; clock?: Clock; standing?: StandingChecks;
  /** The gym's random key (`areas/settings/gym-keys.ts`); without it, PIN lookups fail closed. */
  pinSecret?: HouseholdPinSecret;
  /** Photo storage for short-lived photo links; without it, identities carry no photo. */
  uploadsFor?: (gymId: string) => Promise<Uploads>;
}
export function createKioskCheckin(options: KioskCheckinOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const standing = options.standing ?? createStandingChecks([inactiveStanding(scope), waiverStanding(scope), createBillingStanding(scope)]);
  const { identities, currentSessions, bookedSessions, record } = createKioskCheckinHelpers({ ...options, scope, clock });

  /**
   * The one household whose PIN matches among households with a member or household name matching the search.
   * `pinChecked` hears whether the guess was compared, and whether it matched.
   */
  async function findHousehold(gymId: string, name: string, pin: string, pinChecked?: PinChecked): Promise<string | null> {
    if (!options.pinSecret) throw new AppError('unavailable', 'Kiosk PIN check-in is not configured');
    const text = name.trim().replace(/\s+/g, ' '), [first, ...rest] = text.split(' ');
    const prefix = (value: string) => escapeLike(value) + '%';
    const candidates = await scope(gymId, (tx) => tx.selectDistinct({ id: households.id, pinHash: households.pinHash })
      .from(members).innerJoin(households, eq(households.id, members.householdId))
      .where(and(isNull(members.anonymizedAt), isNotNull(households.pinHash), or(
        // A household name matches where one of its words starts with the search, never in the middle of a word.
        ilike(members.firstName, prefix(text)), ilike(members.lastName, prefix(text)),
        ilike(households.name, prefix(text)), ilike(households.name, '% ' + prefix(text)),
        rest.length ? and(ilike(members.firstName, prefix(first!)), ilike(members.lastName, prefix(rest.join(' ')))) : undefined,
      ))).limit(maxCandidateHouseholds + 1));
    if (!candidates.length || candidates.length > maxCandidateHouseholds) { pinChecked?.('skipped'); return null; }
    const secret = await options.pinSecret(gymId);
    const matches = candidates.filter((row) => verifyHouseholdPin(secret, gymId, row.id, pin, row.pinHash));
    // Two households sharing a name and PIN can't be told apart: never guess.
    pinChecked?.(matches.length === 1 ? 'verified' : 'compared');
    return matches.length === 1 ? matches[0]!.id : null;
  }
  async function householdMembers(gymId: string, householdId: string): Promise<KioskMemberRow[]> {
    return scope(gymId, (tx) => tx.select({ id: members.id, firstName: members.firstName, lastName: members.lastName, photoKey: members.photoKey })
      .from(members).where(and(eq(members.householdId, householdId), isNull(members.anonymizedAt)))
      .orderBy(asc(members.firstName), asc(members.id)));
  }

  return {
    async lookup(gymId: string, input: unknown, pinChecked?: PinChecked): Promise<KioskLookupResponse['data']> {
      const { name, pin } = kioskLookupRequestSchema.parse(input);
      const householdId = await findHousehold(gymId, name, pin, pinChecked);
      const rows = householdId ? await householdMembers(gymId, householdId) : [];
      if (!rows.length) return { status: 'see_front_desk' };
      const people = await identities(gymId, rows);
      return { status: 'select_member', members: rows.map((row) => people.get(row.id)!) };
    },
    /** Rechecks the name and PIN on every submission; results keep the order of the selections. */
    async checkin(gymId: string, deviceId: string, input: unknown, pinChecked?: PinChecked): Promise<KioskCheckinResult[]> {
      const { name, pin, checkins } = kioskNamePinCheckinRequestSchema.parse(input);
      const householdId = await findHousehold(gymId, name, pin, pinChecked);
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
