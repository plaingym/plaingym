// SPDX-License-Identifier: AGPL-3.0-only
import { portalContracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { portalIdentity } from './auth.permissions.js';
import { createPortalPwaRoutes } from './auth.pwa.js';

export function createPortalAuthRoutes(households = createMemberHouseholdContext()) {
  const contract = portalContracts.context;
  return [route({ ...contract, responses: { 200: { description: 'Current member access', content: { 'application/json': { schema: contract.response } } } } }, async ctx => {
    const scope = await households.resolve(portalIdentity(ctx.get('context')));
    ctx.header('Cache-Control', 'no-store');
    ctx.header('Vary', 'Cookie');
    return ctx.json({ data: scope.role === 'payer' ? { role: 'payer' as const, householdId: scope.householdId, memberId: scope.memberId ?? null }
      : { role: 'member' as const, householdId: scope.householdId, memberId: scope.memberId } }, 200);
  })];
}
export const routes = [...createPortalAuthRoutes(), ...createPortalPwaRoutes()];
