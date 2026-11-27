// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Reviewed exact-name expression over imported gym-owned columns, used inside forGym only.
import { and, asc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { forGym, households, members, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import {
  kioskLookupRequestSchema, kioskNamePinCheckinRequestSchema,
  type KioskCheckinResult, type KioskLookupResponse, type KioskStanding,
} from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../../core/clock.js';
import { escapeLike } from '../../../lib/escape-like.js';
import type { Uploads } from '../../../infra/storage/index.js';
import { createKioskCheckinHelpers, type KioskMemberRow } from '../checkin.js';
import type { KioskPinCheck } from '../pin-check.js';
import { verifyHouseholdPin, type HouseholdPinSecret } from '../../members/pin.js';
import { billingStandingReasons, createBillingStanding, createCreditsStanding } from '../../billing/kiosk-standing.js';
import { createStandingChecks, inactiveStanding, waiverStanding, type StandingChecks } from './standing.js';

export { checkinOpensBeforeMs } from '../checkin.js';
/**
 * Bounds the households one PIN guess is checked against, so a guess can't land in whichever of many matching
 * households shares it. A wider match goes to the front desk; a first and last name narrows a common surname.
 */
export const maxCandidateHouseholds = 3;
/** Wrong PINs in a row that lock a household's name-and-PIN check-in, and how long the lock lasts. */
export const pinLockAfter = 5;
export const pinLockMs = 15 * 60_000;
/** A household's wrong-PIN count starts again after this long without a wrong PIN. */
export const pinCountWindowMs = 15 * 60_000;
/** Hears what one PIN guess came to; the kiosk limiter spends budget only on wrong PINs (`devices.auth.ts`). */
export type PinChecked = (check: KioskPinCheck) => void;

export interface KioskCheckinOptions {
  scope?: typeof forGym; clock?: Clock; standing?: StandingChecks;
  /** The gym's random key (`areas/settings/gym-keys.ts`); without it, PIN lookups fail closed. */
  pinSecret?: HouseholdPinSecret;
  /** Photo storage for short-lived photo links; without it, identities carry no photo. */
  uploadsFor?: (gymId: string) => Promise<Uploads>;
}
export function createKioskCheckin(options: KioskCheckinOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const standing = options.standing ?? createStandingChecks([inactiveStanding(scope), waiverStanding(scope), createBillingStanding(scope), createCreditsStanding(scope)]);
  const { identities, currentSessions, bookedSessions, record } = createKioskCheckinHelpers({ ...options, scope, clock });

  /**
   * The one household whose PIN matches among households with a member or household name matching the search; when
   * some household's name equals the search, only such a household. `pinChecked` hears whether the guess was compared, and whether it matched.
   */
  async function findHousehold(gymId: string, name: string, pin: string, pinChecked?: PinChecked): Promise<string | null> {
    if (!options.pinSecret) throw new AppError('unavailable', 'Kiosk PIN check-in is not configured');
    const text = name.trim().replace(/\s+/g, ' '), [first, ...rest] = text.split(' ');
    const prefix = (value: string) => escapeLike(value) + '%';
    // A matching member's full name, or the household name, equals the search (ignoring case and spacing).
    const spaced = (value: SQL) => sql`lower(regexp_replace(trim(${value}), '\\s+', ' ', 'g'))`;
    const exact = sql<boolean>`bool_or(${spaced(sql`${members.firstName} || ' ' || ${members.lastName}`)} = lower(${text})
      or ${spaced(sql`${households.name}`)} = lower(${text}))`;
    const candidates = await scope(gymId, (tx) => tx.select({ id: households.id, pinHash: households.pinHash, exact })
      .from(members).innerJoin(households, eq(households.id, members.householdId))
      .where(and(isNull(members.anonymizedAt), isNotNull(households.pinHash), or(
        // A household name matches where one of its words starts with the search, never in the middle of a word.
        ilike(members.firstName, prefix(text)), ilike(members.lastName, prefix(text)),
        ilike(households.name, prefix(text)), ilike(households.name, '% ' + prefix(text)),
        rest.length ? and(ilike(members.firstName, prefix(first!)), ilike(members.lastName, prefix(rest.join(' ')))) : undefined,
      ))).groupBy(households.id, households.pinHash).limit(maxCandidateHouseholds + 1));
    // A guess with no candidate, or too many, compares no PIN and needs no key, so it changes nothing.
    if (!candidates.length || candidates.length > maxCandidateHouseholds) { pinChecked?.('skipped'); return null; }
    // Resolve the key between the transactions (the resolver may read the gym).
    const secret = await options.pinSecret(gymId);
    const exactIds = new Set(candidates.filter((row) => row.exact).map((row) => row.id));
    const { check, householdId } = await scope(gymId, async (tx): Promise<{ check: KioskPinCheck; householdId: string | null }> => {
      // Lock the candidates in ID order, so concurrent guesses at one household all count and never deadlock. The
      // PIN and lock are read again under the lock; a household whose PIN was cleared meanwhile isn't compared.
      const locked = await tx.select({ id: households.id, pinHash: households.pinHash, pinFailedCount: households.pinFailedCount,
        pinLockedUntil: households.pinLockedUntil, pinFailedAt: households.pinFailedAt })
        .from(households).where(and(inArray(households.id, candidates.map((row) => row.id)), isNotNull(households.pinHash)))
        .orderBy(asc(households.id)).for('update');
      // Every PIN cleared since the candidate query: nothing is compared.
      if (!locked.length) return { check: 'skipped', householdId: null };
      const now = clock.now(), open = locked.filter((row) => !row.pinLockedUntil || row.pinLockedUntil.getTime() <= now.getTime());
      // Locked households are compared too, so they still take part in the tie rule (a locked household never hands
      // its guess to another household sharing its PIN) and a guess does the same work whether or not one is locked.
      const matches = locked.filter((row) => verifyHouseholdPin(secret, gymId, row.id, pin, row.pinHash));
      // A search naming households exactly aims at them: only a named household can be found, and a wrong guess counts
      // only there, never on households whose names merely start the same. A guess at a named household can't check in
      // another one whose PIN it happens to match, so guesses at an uncounted household never find it. A named
      // household under a PIN lock counts too, so a guess at it counts on no other. Whether the search names a household
      // comes from the candidates, so a named household whose PIN was cleared meanwhile still keeps the others unfound.
      const named = locked.filter((row) => exactIds.has(row.id)), namesAny = exactIds.size > 0;
      // With no household named, the only match is found. An exact name also breaks a tie between households whose
      // PIN matches, so "a a" isn't lost to "asd asd" sharing its PIN. Two households still tied can't be told apart:
      // never guess.
      const exactMatches = matches.filter((row) => exactIds.has(row.id));
      const found = exactMatches.length === 1 ? exactMatches[0] : !namesAny && matches.length === 1 ? matches[0] : undefined;
      // A locked household's right PIN gets the front-desk answer, like a wrong PIN, and changes no count.
      if (found && !open.includes(found)) return { check: 'compared', householdId: null };
      // These writes leave `revision` alone: a kiosk guess must not make a staff save conflict.
      if (found) {
        if (found.pinFailedCount !== 0 || found.pinLockedUntil || found.pinFailedAt) {
          await tx.update(households).set({ pinFailedCount: 0, pinLockedUntil: null, pinFailedAt: null }).where(eq(households.id, found.id));
        }
        return { check: 'verified', householdId: found.id };
      }
      // A wrong guess counts on every open household it was compared with, or only on the named ones when the search
      // names any; households whose PIN matched (tied, or not named) keep theirs.
      for (const row of open) {
        if (matches.includes(row) || (namesAny && !named.includes(row))) continue;
        // The count starts again after a quiet spell; a count stored without a time starts again too.
        const recent = row.pinFailedAt !== null && now.getTime() - row.pinFailedAt.getTime() < pinCountWindowMs;
        const count = (recent ? row.pinFailedCount : 0) + 1;
        if (count < pinLockAfter) {
          await tx.update(households).set({ pinFailedCount: count, pinFailedAt: now }).where(eq(households.id, row.id));
          continue;
        }
        const lockedUntil = new Date(now.getTime() + pinLockMs);
        await tx.update(households).set({ pinFailedCount: 0, pinLockedUntil: lockedUntil, pinFailedAt: null }).where(eq(households.id, row.id));
        await writeAudit(tx, { gymId, actorKind: 'system', action: 'household.pin_locked', targetType: 'household', targetId: row.id,
          occurredAt: now, after: { lockedUntil: lockedUntil.toISOString() } });
      }
      // Every candidate locked still spends the device budget, like a wrong PIN.
      return { check: 'compared', householdId: null };
    });
    pinChecked?.(check);
    return householdId;
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
    /**
     * Staff view of why the kiosk would send a member to the front desk. Without `billing`, billing reasons become one
     * `see_front_desk` in the first one's place, so staff who can't read billing don't learn who is behind on payments.
     */
    async memberStanding(gymId: string, memberId: string, billing: boolean): Promise<KioskStanding> {
      const [row] = await scope(gymId, (tx) => tx.select({ id: members.id }).from(members).where(eq(members.id, memberId)));
      if (!row) throw new AppError('not_found', 'Resource not found');
      const result = await standing.evaluate({ gymId, memberId, clock });
      const reasons = billing ? [...result.reasons] : result.reasons.flatMap((reason, index) => !billingStandingReasons.includes(reason) ? [reason]
        : result.reasons.findIndex((other) => billingStandingReasons.includes(other)) === index ? ['see_front_desk'] : []);
      return { memberId, status: result.status, reasons };
    },
  };
}
export type KioskCheckin = ReturnType<typeof createKioskCheckin>;
