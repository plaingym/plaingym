// SPDX-License-Identifier: AGPL-3.0-only
import * as c from '@plaingym/shared/contracts';
import { billingRoute, billingMutation } from './catalog.routes.js';
import { createMembershipService, type MembershipService } from './memberships.js';
import { logError } from '../../core/log.js';

let configured: MembershipService | undefined;
interface MembershipHooks {
  assigned(gymId: string, householdId: string): Promise<{ errors: readonly { invoiceId: string; message: string }[] }>;
}
let configuredHooks: MembershipHooks | undefined;
const fallback = createMembershipService();
export function configureMemberships(service: MembershipService, hooks?: MembershipHooks) { configured = service; configuredHooks = hooks; }
export function membershipService() { return configured ?? fallback; }
export function createMembershipRoutes(service?: MembershipService, hooks?: MembershipHooks) {
  const read = () => service ?? membershipService();
  return [
    billingRoute(c.billingContracts.listMemberships, async (ctx, _p, q) => read().list(ctx.gym.gymId, q)),
    billingRoute(c.billingContracts.getMembership, async (ctx, p) => ({ data: await read().get(ctx.gym.gymId, p.membershipId!) })),
    billingRoute(c.billingContracts.assignMembership, async (ctx, _p, _q, b) => {
      const data = await read().assignFromCatalog(billingMutation(ctx), c.assignMembershipRequestSchema.parse(b));
      // Assignment is committed before collection; a provider outage is recovered by the daily sweep.
      const assigned = (service ? hooks : configuredHooks)?.assigned;
      if (assigned) {
        try {
          const result = await assigned(ctx.gym.gymId, data.householdId);
          for (const error of result.errors) logError('billing.collect_assigned', { gymId: ctx.gym.gymId }, new Error(error.message));
        } catch (error) { logError('billing.collect_assigned', { gymId: ctx.gym.gymId }, error); }
      }
      return { data };
    }),
    billingRoute(c.billingContracts.updateMembership, async (ctx, p, _q, b) => ({ data: await read().update(billingMutation(ctx), { ...c.updateMembershipRequestSchema.parse(b), membershipId: p.membershipId! }) })),
    billingRoute(c.billingContracts.activateMembership, async (ctx, p, _q, b) => ({ data: await read().activate(billingMutation(ctx), { ...c.activateMembershipRequestSchema.parse(b), membershipId: p.membershipId! }) })),
    billingRoute(c.billingContracts.freezeMembership, async (ctx, p, _q, b) => ({ data: await read().freeze(billingMutation(ctx), { ...c.freezeMembershipRequestSchema.parse(b), membershipId: p.membershipId! }) })),
    billingRoute(c.billingContracts.resumeMembership, async (ctx, p, _q, b) => ({ data: await read().activate(billingMutation(ctx), { ...c.resumeMembershipRequestSchema.parse(b), membershipId: p.membershipId! }) })),
    billingRoute(c.billingContracts.cancelMembership, async (ctx, p, _q, b) => ({ data: await read().cancel(billingMutation(ctx), { ...c.cancelMembershipRequestSchema.parse(b), membershipId: p.membershipId! }) })),
  ];
}
export const routes = createMembershipRoutes();
