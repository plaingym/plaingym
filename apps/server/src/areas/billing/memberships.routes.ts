// SPDX-License-Identifier: AGPL-3.0-only
import * as c from '@plaingym/shared/contracts';
import { billingRoute, billingMutation } from './catalog.routes.js';
import { createMembershipService, type MembershipService } from './memberships.js';
import { logError } from '../../core/log.js';

let configured: MembershipService | undefined;
interface MembershipHooks {
  assigned(gymId: string, householdId: string): Promise<{ errors: readonly { invoiceId: string }[] }>;
}
let configuredHooks: MembershipHooks | undefined;
const fallback = createMembershipService();
export function configureMemberships(service: MembershipService, hooks?: MembershipHooks) { configured = service; configuredHooks = hooks; }
export function membershipService() { return configured ?? fallback; }
export function createMembershipRoutes(service?: MembershipService, hooks?: MembershipHooks) {
  const read = () => service ?? membershipService();
  /**
   * Charges the household's new assignment-kind invoices with the saved card, after the change that issued them has
   * committed. A provider failure never undoes the change: the daily sweep and dunning carry on as for any of them.
   */
  async function collect(gymId: string, householdId: string) {
    const assigned = (service ? hooks : configuredHooks)?.assigned;
    if (!assigned) return;
    try {
      const result = await assigned(gymId, householdId);
      for (const error of result.errors) logError('billing.collect_assigned', { gymId, invoiceId: error.invoiceId });
    } catch (error) { logError('billing.collect_assigned', { gymId }, error); }
  }
  return [
    billingRoute(c.billingContracts.listMemberships, async (ctx, _p, q) => read().list(ctx.gym.gymId, q)),
    billingRoute(c.billingContracts.getMembership, async (ctx, p) => ({ data: await read().get(ctx.gym.gymId, p.membershipId!) })),
    billingRoute(c.billingContracts.assignMembership, async (ctx, _p, _q, b) => {
      const data = await read().assignFromCatalog(billingMutation(ctx), c.assignMembershipRequestSchema.parse(b));
      await collect(ctx.gym.gymId, data.householdId);
      return { data };
    }),
    billingRoute(c.billingContracts.updateMembership, async (ctx, p, _q, b) => ({ data: await read().update(billingMutation(ctx), { ...c.updateMembershipRequestSchema.parse(b), membershipId: p.membershipId! }) })),
    billingRoute(c.billingContracts.setMembershipDiscount, async (ctx, p, _q, b) => ({ data: await read().setDiscount(billingMutation(ctx),
      p.membershipId!, c.setMembershipDiscountRequestSchema.parse(b)) })),
    billingRoute(c.billingContracts.removeMembershipDiscount, async (ctx, p, _q, b) => ({ data: await read().removeDiscount(billingMutation(ctx),
      p.membershipId!, c.removeMembershipDiscountRequestSchema.parse(b)) })),
    billingRoute(c.billingContracts.switchMembershipPlan, async (ctx, p, _q, b) => {
      const data = await read().switchPlan(billingMutation(ctx), { ...c.switchMembershipPlanRequestSchema.parse(b), membershipId: p.membershipId! });
      // A replay collects again: an invoice whose charge was never attempted (a crash after commit) is charged once, and
      // one already attempted is left to its attempt.
      if (data.invoiceId) await collect(ctx.gym.gymId, data.membership.householdId);
      return { data };
    }),
    billingRoute(c.billingContracts.cancelMembershipSwitch, async (ctx, p, _q, b) => ({ data: await read().cancelScheduledSwitch(billingMutation(ctx),
      { ...c.cancelMembershipSwitchRequestSchema.parse(b), membershipId: p.membershipId! }) })),
    billingRoute(c.billingContracts.previewMembershipSwitch, async (ctx, p, q) => ({ data: await read().previewSwitch(ctx.gym.gymId,
      p.membershipId!, c.membershipSwitchPreviewQuerySchema.parse(q)) })),
    billingRoute(c.billingContracts.activateMembership, async (ctx, p, _q, b) => ({ data: await read().activate(billingMutation(ctx), { ...c.activateMembershipRequestSchema.parse(b), membershipId: p.membershipId! }) })),
    billingRoute(c.billingContracts.freezeMembership, async (ctx, p, _q, b) => ({ data: await read().freeze(billingMutation(ctx), { ...c.freezeMembershipRequestSchema.parse(b), membershipId: p.membershipId! }) })),
    billingRoute(c.billingContracts.resumeMembership, async (ctx, p, _q, b) => ({ data: await read().activate(billingMutation(ctx), { ...c.resumeMembershipRequestSchema.parse(b), membershipId: p.membershipId! }) })),
    billingRoute(c.billingContracts.cancelMembership, async (ctx, p, _q, b) => ({ data: await read().cancel(billingMutation(ctx), { ...c.cancelMembershipRequestSchema.parse(b), membershipId: p.membershipId! }) })),
  ];
}
export const routes = createMembershipRoutes();
