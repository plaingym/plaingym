// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNull } from 'drizzle-orm';
import { forGym, householdUsers, households, members, staffRoles } from '@plaingym/db';
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

type Login = typeof householdUsers.$inferSelect;
const usable = (login: Login) => login.scope === 'payer' || (login.scope === 'member' && Boolean(login.memberId));
function memberPrincipal(gymId: string, userId: string, login: Login): Principal {
  return login.scope === 'payer'
    ? { kind: 'member', userId, scope: { gymId, householdId: login.householdId, role: 'payer', ...(login.memberId ? { memberId: login.memberId } : {}) } }
    : { kind: 'member', userId, scope: { gymId, householdId: login.householdId, role: 'member', memberId: login.memberId! } };
}
/** The session's chosen household, rechecked against the user's current links; one link needs no choice. */
function chosenLogin(logins: readonly Login[], session?: PortalSessionChoice) {
  const valid = logins.filter(usable);
  return valid.find(login => login.householdId === session?.householdId) ?? (valid.length === 1 ? valid[0] : undefined);
}
/** Only the household chosen for this session, as stored server-side by the session store. */
export interface PortalSessionChoice { readonly householdId?: string | null }

/** Called only with a gym-bound session's user ID. Never takes a role or household from request input. */
export function createPortalPrincipalLoader(scope = forGym) {
  return (gymId: string, userId: string, session?: PortalSessionChoice): Promise<Principal> => scope(gymId, async tx => {
    const roles = await tx.select({ role: staffRoles.role }).from(staffRoles).where(eq(staffRoles.userId, userId));
    // Staff identities retain their staff principal, even if they also pay for a household.
    if (roles.length) return { kind: 'staff', gymId, userId, roles: roles.flatMap(row => validRoles.filter(role => role === row.role)) };
    const logins = await tx.select().from(householdUsers).where(eq(householdUsers.userId, userId)).orderBy(asc(householdUsers.createdAt), asc(householdUsers.id));
    const login = chosenLogin(logins, session);
    if (login) return memberPrincipal(gymId, userId, login);
    // A signed-in user without a role or a usable household link, or with several links and no current
    // choice, keeps a session with no access: the admin explains it, and the portal offers its picker.
    return { kind: 'staff', gymId, userId, roles: [] };
  });
}

/** The households this signed-in user may choose between in the portal. Staff identities have none. */
export function createPortalHouseholdChoices(scope = forGym) {
  return {
    async list(gymId: string, userId: string) {
      return scope(gymId, async tx => {
        if ((await tx.select({ id: staffRoles.id }).from(staffRoles).where(eq(staffRoles.userId, userId)).limit(1)).length) return [];
        const rows = await tx.select({ login: householdUsers, name: households.name }).from(householdUsers)
          .innerJoin(households, eq(households.id, householdUsers.householdId)).where(eq(householdUsers.userId, userId))
          .orderBy(asc(households.name), asc(households.id));
        return rows.filter(row => usable(row.login)).map(row => ({ householdId: row.login.householdId, name: row.name, role: row.login.scope as 'payer' | 'member' }));
      });
    },
  };
}
