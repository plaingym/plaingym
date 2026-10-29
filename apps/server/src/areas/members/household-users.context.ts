// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNull } from 'drizzle-orm';
import { forGym, householdUsers, members, staffRoles } from '@plaingym/db';
import { canMember, staffRoles as validRoles } from '@plaingym/shared';
import type { MemberHouseholdContext, PortalIdentity, PortalContext } from '../../core/interfaces/member-household.js';
import type { Principal } from '../../core/context.js';
import { notFound } from '../../core/interfaces/common.js';

/** Authorization snapshots only. Resource readers must still use forHousehold. */
export function createMemberHouseholdContext(scope = forGym): MemberHouseholdContext {
  const resolve = (identity: PortalIdentity): Promise<PortalContext> => scope(identity.gymId, async tx => {
    const [login] = await tx.select().from(householdUsers).where(and(
      eq(householdUsers.userId, identity.userId), eq(householdUsers.householdId, identity.householdId),
    ));
    if (!login || (login.scope !== 'payer' && login.scope !== 'member') || (login.scope === 'member' && !login.memberId)) notFound();
    const visible = await tx.select({ id: members.id }).from(members).where(and(
      isNull(members.anonymizedAt),
      eq(members.householdId, login.householdId), login.scope === 'member' ? eq(members.id, login.memberId!) : undefined,
    )).orderBy(asc(members.id));
    const base = { ...identity, visibleMemberIds: visible.map(row => row.id) };
    return login.scope === 'payer' ? { ...base, role: 'payer', ...(login.memberId ? { memberId: login.memberId } : {}) }
      : { ...base, role: 'member', memberId: login.memberId! };
  });
  return {
    resolve,
    async requireMember(identity, memberId, permission) {
      const context = await resolve(identity);
      if (!canMember(context.role, permission) || !context.visibleMemberIds.includes(memberId)) notFound();
      return context;
    },
    async requirePayer(identity, permission) {
      const context = await resolve(identity);
      if (context.role !== 'payer' || !canMember(context.role, permission)) notFound();
      return context;
    },
  };
}

/** Called only with a gym-bound session's user ID. Never takes a role or household from request input. */
export function createPortalPrincipalLoader(scope = forGym) {
  return (gymId: string, userId: string): Promise<Principal> => scope(gymId, async tx => {
    const roles = await tx.select({ role: staffRoles.role }).from(staffRoles).where(eq(staffRoles.userId, userId));
    // Staff identities retain their staff principal, even if they also pay for a household.
    if (roles.length) return { kind: 'staff', gymId, userId, roles: roles.flatMap(row => validRoles.filter(role => role === row.role)) };
    const [login] = await tx.select().from(householdUsers).where(eq(householdUsers.userId, userId)).orderBy(asc(householdUsers.createdAt), asc(householdUsers.id)).limit(1);
    if (!login) return { kind: 'anonymous' };
    if (login.scope === 'payer') return { kind: 'member', userId, scope: { gymId, householdId: login.householdId, role: 'payer', ...(login.memberId ? { memberId: login.memberId } : {}) } };
    if (login.scope === 'member' && login.memberId) return { kind: 'member', userId, scope: { gymId, householdId: login.householdId, role: 'member', memberId: login.memberId } };
    return { kind: 'anonymous' };
  });
}
