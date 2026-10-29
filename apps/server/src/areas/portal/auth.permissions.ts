// SPDX-License-Identifier: AGPL-3.0-only
import { canMember } from '@plaingym/shared';
import type { PermissionMiddleware } from '../../core/registry.js';
import type { MemberHouseholdContext, PortalIdentity } from '../../core/interfaces/member-household.js';
import type { RequestContext } from '../../core/context.js';
import { notFound } from '../../core/interfaces/common.js';
import { authorize } from '../staff/auth.permissions.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';

export function portalIdentity(context: RequestContext): PortalIdentity {
  const { principal, gym } = context;
  if (principal.kind !== 'member' || principal.scope.gymId !== gym.gymId) notFound();
  return { gymId: gym.gymId, userId: principal.userId, householdId: principal.scope.householdId };
}
/** Mount portal routes with this middleware; cached/request-supplied roles never authorize a request. */
export function createPortalAuthorization(households: MemberHouseholdContext = createMemberHouseholdContext()): PermissionMiddleware {
  return permission => permission.kind !== 'member' ? authorize(permission) : async (ctx, next) => {
    const current = ctx.get('context');
    const scope = await households.resolve(portalIdentity(current));
    if (!canMember(scope.role, permission.capability)) notFound();
    ctx.set('context', { ...current, principal: { kind: 'member', userId: scope.userId, scope } });
    await next();
  };
}
