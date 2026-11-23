// SPDX-License-Identifier: AGPL-3.0-only
import { forHousehold, HouseholdAccessError } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import {
  paginationSchema, portalHouseholdSchema, portalHouseholdUpdateRequestSchema, portalMemberSchema, portalMemberUpdateRequestSchema,
  portalMembershipSchema, type Pagination, type PortalEmergencyContact, type PortalHouseholdUpdateRequest, type PortalMemberUpdateRequest,
  type ChangeSmsConsentRequest, type ChangeHouseholdSmsConsentRequest,
} from '@plaingym/shared/contracts';
import type { MemberHouseholdContext, PortalIdentity } from '../../core/interfaces/member-household.js';
import { notFound } from '../../core/interfaces/common.js';
import { clock as defaultClock } from '../../core/clock.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { createMembersService, type MembersService } from '../members/members.js';
import { needsGuardian } from '../waivers/snapshot.js';
import { smsState, readPhoneCountry, withoutSmsColumns } from '../members/member-write.js';
import { createGymSettingsAccessor } from '../settings/settings.js';

export type HouseholdQueries = Parameters<Parameters<typeof forHousehold>[1]>[0];
type StoredContact = { name: string; relationship: string | null; phone: string; email: string | null };
/** Contacts keep their stored shape; an empty relationship is stored and shown as none. */
const contact = (row: StoredContact): PortalEmergencyContact => ({ name: row.name, relationship: row.relationship?.trim() || null,
  phone: row.phone, ...(row.email ? { email: row.email } : {}) });
const stored = (row: PortalEmergencyContact): StoredContact => ({ name: row.name, phone: row.phone, email: row.email ?? null,
  relationship: row.relationship?.trim() || null });

type OptedOut = ReadonlyMap<string, string>;
const noOptOuts: OptedOut = new Map();
/** The STOP date is read in the same household transaction as the rows, for rows with a phone, and shown only for a valid number. */
const optedOutFor = (queries: HouseholdQueries, type: 'member' | 'household', rows: readonly { id: string; phone: string | null }[]) => {
  const ids = rows.filter(row => row.phone).map(row => row.id);
  return ids.length ? queries.smsOptedOut(type, ids) : Promise.resolve(noOptOuts);
};
function sms<T extends { phoneE164: string | null }>(state: T, id: string, optedOut: OptedOut) {
  return { ...state, optedOutAt: state.phoneE164 ? optedOut.get(id) ?? null : null };
}
function project(row: Awaited<ReturnType<HouseholdQueries['members']>>[number], country: string | null | undefined, optedOut: OptedOut) {
  return portalMemberSchema.parse({ id: row.id, firstName: row.firstName, lastName: row.lastName, email: row.email, phone: row.phone,
    sms: sms(smsState(row, row.phone, country), row.id, optedOut),
    dateOfBirth: row.dateOfBirth, photoKey: row.photoKey, status: row.status, revision: row.revision,
    emergencyContacts: ('emergencyContacts' in row ? row.emergencyContacts as StoredContact[] | null : null)?.map(contact) ?? [] });
}

/** Opens the household boundary for a portal identity; a denied or missing grant is the same not-found response. */
export function householdReader(scope: typeof forHousehold) {
  return async function read<T>(identity: PortalIdentity, fn: (queries: HouseholdQueries) => Promise<T>) {
    try { return await scope({ kind: 'user', ...identity }, fn); }
    catch (error) {
      if (error instanceof HouseholdAccessError) notFound();
      throw error;
    }
  };
}
/** OpenAPI 200 response for a portal route. */
export const ok = <T>(description: string, schema: T) => ({ 200: { description, content: { 'application/json': { schema } } } });

/**
 * Whom a payer may act for (edit a profile, sign or upload a waiver): their own member, and children whose recorded
 * birth date makes them under 18 in the gym's timezone. An unknown birth date proves nothing, so that member is
 * refused here; the waiver service still requires a guardian signature for them. Member-only logins need a recorded
 * adult birth date, so an adult with their own login is always refused too.
 */
export function payerMayActFor(context: { readonly memberId?: string }, member: { id: string; dateOfBirth: string | null }, now: Date, timezone: string) {
  return member.id === context.memberId || (member.dateOfBirth !== null && needsGuardian(member.dateOfBirth, now, timezone));
}

/** Read-only household access for portal logins; edits go through the members service after the household check. */
export function createPortalHouseholdService(options: {
  households?: MemberHouseholdContext; householdScope?: typeof forHousehold; members?: MembersService; clock?: Clock;
} = {}) {
  const households = options.households ?? createMemberHouseholdContext(), scope = options.householdScope ?? forHousehold;
  const clock = options.clock ?? defaultClock, members = options.members ?? createMembersService({ clock });
  const settings = createGymSettingsAccessor();
  const read = householdReader(scope);
  const phoneCountry = (gymId: string, phones: readonly (string | null)[]) =>
    readPhoneCountry(phones, async () => (await settings.get(gymId)).country);
  async function member(identity: PortalIdentity, id: string) {
    const { row, optedOut } = await read(identity, async queries => {
      const rows = await queries.member(id);
      return { row: rows[0], optedOut: await optedOutFor(queries, 'member', rows) };
    });
    return row ? project(row, await phoneCountry(identity.gymId, [row.phone]), optedOut) : notFound();
  }
  async function household(identity: PortalIdentity) {
    const { row, optedOut } = await read(identity, async queries => {
      const rows = await queries.household();
      return { row: rows[0], optedOut: await optedOutFor(queries, 'household', rows) };
    });
    if (!row) notFound();
    return portalHouseholdSchema.parse({ ...withoutSmsColumns(row),
      sms: sms(smsState(row, row.phone, await phoneCountry(identity.gymId, [row.phone])), row.id, optedOut),
      address: Object.fromEntries(Object.entries(row.address ?? {}).filter(([, value]) => typeof value === 'string')) });
  }
  const actor = (identity: PortalIdentity) => ({ gymId: identity.gymId, actor: { kind: 'user' as const, userId: identity.userId } });
  return {
    /** Payers read every current household member; an adult member reads only their own profile. */
    async profile(identity: PortalIdentity, memberId: string) {
      await households.requireMember(identity, memberId, 'profile.read');
      return member(identity, memberId);
    },
    async list(identity: PortalIdentity, input: Pagination) {
      const query = paginationSchema.parse(input), context = await households.requirePayer(identity, 'household.read');
      const { rows, page, optedOut } = await read(identity, async queries => {
        const rows = (await queries.members()).filter(row => context.visibleMemberIds.includes(row.id))
          .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName) || a.id.localeCompare(b.id));
        // A page holds at most 100 members, so their STOP dates come from one batched read.
        const page = rows.slice(query.offset, query.offset + query.limit);
        return { rows, page, optedOut: await optedOutFor(queries, 'member', page) };
      });
      const country = await phoneCountry(identity.gymId, page.map(row => row.phone));
      return { data: page.map(row => project(row, country, optedOut)), pagination: { limit: query.limit, offset: query.offset, total: rows.length } };
    },
    /** Payers edit their own profile and children's profiles; status, memberships and check-in credentials are not fields here. */
    async updateMember(identity: PortalIdentity, memberId: string, input: PortalMemberUpdateRequest, timezone: string) {
      const { emergencyContacts, photoKey, ...changes } = portalMemberUpdateRequestSchema.parse(input);
      const context = await households.requireMember(identity, memberId, 'household.manage');
      const current = await member(identity, memberId);
      if (!payerMayActFor(context, current, clock.now(), timezone)) throw new AppError('forbidden', 'Adults manage their own profile');
      if (photoKey !== undefined && photoKey !== current.photoKey) throw new AppError('invalid_request', 'Photos are managed by the gym');
      await members.updateMember(actor(identity), memberId, { ...changes, ...(emergencyContacts ? { emergencyContacts: emergencyContacts.map(stored) } : {}) }, 'portal');
      return member(identity, memberId);
    },
    household(identity: PortalIdentity) { return households.requirePayer(identity, 'household.read').then(() => household(identity)); },
    async updateHousehold(identity: PortalIdentity, input: PortalHouseholdUpdateRequest) {
      const changes = portalHouseholdUpdateRequestSchema.parse(input);
      await households.requirePayer(identity, 'household.manage');
      // Through the household boundary first; the members service then writes with the revision check and audit.
      await household(identity);
      await members.updateHousehold(actor(identity), identity.householdId, changes, 'portal');
      return household(identity);
    },
    async changeMemberSmsConsent(identity: PortalIdentity, memberId: string, input: ChangeSmsConsentRequest, timezone: string) {
      const context = await households.requireMember(identity, memberId, 'sms_consent.manage');
      const current = await member(identity, memberId);
      if (!payerMayActFor(context, current, clock.now(), timezone)) throw new AppError('forbidden', 'Adults manage their own consent');
      await members.changeMemberSmsConsent(actor(identity), memberId, input, 'portal');
      return member(identity, memberId);
    },
    async changeHouseholdSmsConsent(identity: PortalIdentity, input: ChangeHouseholdSmsConsentRequest) {
      await households.requirePayer(identity, 'household.manage');
      await household(identity);
      await members.changeHouseholdSmsConsent(actor(identity), identity.householdId, input, 'portal');
      return household(identity);
    },
    /** Memberships are read-only in the portal; staff make every membership change. */
    async memberships(identity: PortalIdentity, memberId: string, input: Pagination) {
      const query = paginationSchema.parse(input);
      await households.requireMember(identity, memberId, 'profile.read');
      const { rows, total } = await read(identity, queries => queries.membershipPage(memberId, query));
      return { data: rows.map(row => portalMembershipSchema.parse(row)), pagination: { limit: query.limit, offset: query.offset, total } };
    },
  };
}
export type PortalHouseholdService = ReturnType<typeof createPortalHouseholdService>;
