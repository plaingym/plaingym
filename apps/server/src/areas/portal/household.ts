// SPDX-License-Identifier: AGPL-3.0-only
import { forHousehold } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import {
  paginationSchema, portalHouseholdSchema, portalHouseholdUpdateRequestSchema, portalMemberSchema, portalMemberUpdateRequestSchema,
  portalMembershipSchema, type Pagination, type PortalEmergencyContact, type PortalHouseholdUpdateRequest, type PortalMemberUpdateRequest,
} from '@plaingym/shared/contracts';
import type { MemberHouseholdContext, PortalIdentity } from '../../core/interfaces/member-household.js';
import { notFound } from '../../core/interfaces/common.js';
import { clock as defaultClock } from '../../core/clock.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { createMembersService, type MembersService } from '../members/members.js';
import { needsGuardian } from '../waivers/snapshot.js';

export type HouseholdQueries = Parameters<Parameters<typeof forHousehold>[1]>[0];
type StoredContact = { name: string; relationship: string | null; phone: string; email: string | null };
/** Contacts keep their stored shape; an empty relationship is stored and shown as none. */
const contact = (row: StoredContact): PortalEmergencyContact => ({ name: row.name, relationship: row.relationship?.trim() || null,
  phone: row.phone, ...(row.email ? { email: row.email } : {}) });
const stored = (row: PortalEmergencyContact): StoredContact => ({ name: row.name, phone: row.phone, email: row.email ?? null,
  relationship: row.relationship?.trim() || null });

function project(row: Awaited<ReturnType<HouseholdQueries['members']>>[number]) {
  return portalMemberSchema.parse({ id: row.id, firstName: row.firstName, lastName: row.lastName, email: row.email, phone: row.phone,
    dateOfBirth: row.dateOfBirth, photoKey: row.photoKey, status: row.status, revision: row.revision,
    emergencyContacts: ('emergencyContacts' in row ? row.emergencyContacts as StoredContact[] | null : null)?.map(contact) ?? [] });
}

/** Opens the household boundary for a portal identity; a denied or missing grant is the same not-found response. */
export function householdReader(scope: typeof forHousehold) {
  return async function read<T>(identity: PortalIdentity, fn: (queries: HouseholdQueries) => Promise<T>) {
    try { return await scope({ kind: 'user', ...identity }, fn); }
    catch (error) {
      if (error instanceof Error && ['Household access denied', 'Payer access required'].includes(error.message)) notFound();
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
  const members = options.members ?? createMembersService(), clock = options.clock ?? defaultClock;
  const read = householdReader(scope);
  async function member(identity: PortalIdentity, id: string) {
    const [row] = await read(identity, queries => queries.member(id));
    return row ? project(row) : notFound();
  }
  async function household(identity: PortalIdentity) {
    const [row] = await read(identity, queries => queries.household());
    if (!row) notFound();
    return portalHouseholdSchema.parse({ ...row, address: Object.fromEntries(Object.entries(row.address ?? {}).filter(([, value]) => typeof value === 'string')) });
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
      const rows = (await read(identity, queries => queries.members())).filter(row => context.visibleMemberIds.includes(row.id))
        .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName) || a.id.localeCompare(b.id));
      return { data: rows.slice(query.offset, query.offset + query.limit).map(project), pagination: { limit: query.limit, offset: query.offset, total: rows.length } };
    },
    /** Payers edit their own profile and children's profiles; status, memberships and check-in credentials are not fields here. */
    async updateMember(identity: PortalIdentity, memberId: string, input: PortalMemberUpdateRequest, timezone: string) {
      const { emergencyContacts, photoKey, ...changes } = portalMemberUpdateRequestSchema.parse(input);
      const context = await households.requireMember(identity, memberId, 'household.manage');
      const current = await member(identity, memberId);
      if (!payerMayActFor(context, current, clock.now(), timezone)) throw new AppError('forbidden', 'Adults manage their own profile');
      if (photoKey !== undefined && photoKey !== current.photoKey) throw new AppError('invalid_request', 'Photos are managed by the gym');
      await members.updateMember(actor(identity), memberId, { ...changes, ...(emergencyContacts ? { emergencyContacts: emergencyContacts.map(stored) } : {}) });
      return member(identity, memberId);
    },
    household(identity: PortalIdentity) { return households.requirePayer(identity, 'household.read').then(() => household(identity)); },
    async updateHousehold(identity: PortalIdentity, input: PortalHouseholdUpdateRequest) {
      const changes = portalHouseholdUpdateRequestSchema.parse(input);
      await households.requirePayer(identity, 'household.manage');
      // Through the household boundary first; the members service then writes with the revision check and audit.
      await household(identity);
      await members.updateHousehold(actor(identity), identity.householdId, changes);
      return household(identity);
    },
    /** Memberships are read-only in the portal; staff make every membership change. */
    async memberships(identity: PortalIdentity, memberId: string, input: Pagination) {
      const query = paginationSchema.parse(input);
      await households.requireMember(identity, memberId, 'profile.read');
      const rows = (await read(identity, queries => queries.memberships())).filter(row => row.memberId === memberId)
        .sort((a, b) => b.startsOn.localeCompare(a.startsOn) || b.id.localeCompare(a.id));
      return { data: rows.slice(query.offset, query.offset + query.limit).map(row => portalMembershipSchema.parse({
        id: row.id, memberId: row.memberId, planId: row.planId, status: row.status, interval: row.interval, startsOn: row.startsOn,
        nextDueOn: row.nextDueOn, trialEndsOn: row.trialEndsOn, commitmentEndsOn: row.commitmentEndsOn, revision: row.revision })),
      pagination: { limit: query.limit, offset: query.offset, total: rows.length } };
    },
  };
}
export type PortalHouseholdService = ReturnType<typeof createPortalHouseholdService>;
