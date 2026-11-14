// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, gt, lte, ne, or } from 'drizzle-orm';
import { forGym, memberships, households, members, plans, auditEvents,
  revisionGuard, assertRevised, uuidv7, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { isCalendarDate, localDate } from '@plaingym/shared/time';
import * as c from '@plaingym/shared/contracts';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { MembershipLifecycle, AssignMembership, MembershipEdit, UpdateMembership } from '../../core/interfaces/membership-lifecycle.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { clock as defaultClock } from '../../core/clock.js';
import { gymSettingsAccessor } from '../settings/settings.js';
import { markLeadWon } from '../leads/stages.js';
import { catalogAudit, catalogMissing } from './catalog.js';
import { addCalendarMonths, advanceDue, householdNextDate, trialEnd } from './memberships.calendar.js';
import { cancelScheduledSwitchRequestSchema, checkSwitch, clearedSwitch, planSwitchedAction, recordedSwitch, refuse, rescheduledSwitch, sameSwitchRequest,
  scheduledSwitch, switchedNow, unscheduled, switchPlanRequestSchema, switchScheduledAction, type CancelScheduledSwitchRequest,
  type PlanSwitchedNowAudit, type RecordedSwitchRequest, type SwitchPlanRequest, type SwitchScheduledAudit } from './memberships.plan-change.js';
import { checkNow, issuable, planTaxes, prorateNow, switchPreview } from './memberships.plan-change.now.js';
import { issue } from './runner/store.js';
import { applyDiscount, endDiscount, liveDiscounts, presentDiscount, refuseMembership, resolveDiscount, switchAppliedDiscount } from './discounts/apply.js';

type Row = typeof memberships.$inferSelect;
// The override reason stays out of the Membership contract (erasure clears it; no response or audit carries it), and so
// does the scheduled change's origin, which the shared due-date rule reads.
const serialize = ({ gymId: _gymId, anniversaryOn: _anniversaryOn, switchOverrideReason: _reason, scheduledOrigin: _origin, ...row }: Row,
  discount: c.AppliedMembershipDiscount | null): c.Membership => c.membershipSchema.parse({ ...row, discount,
  createdAt: row.createdAt.toISOString(), frozenAt: row.frozenAt?.toISOString() ?? null,
  cancelledAt: row.cancelledAt?.toISOString() ?? null });
async function present(tx: Transaction, row: Row) {
  return serialize(row, presentDiscount((await liveDiscounts(tx, [row.id])).get(row.id)));
}
// Sort recursively: the discount selection is part of the persisted replay key too.
const fingerprint = (request: AssignMembership) => JSON.stringify(request, (_key, value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const conflict = (message: string): never => { throw new AppError('conflict', message); };
/**
 * A frozen membership that was never active: its latest freeze froze a pending or trial membership. Resuming it is its
 * first activation, so its lead is won then, as for a trial that ends.
 */
async function frozenBeforeActive(tx: Transaction, row: Row): Promise<boolean> {
  if (row.status !== 'frozen') return false;
  const [freeze] = await tx.select({ before: auditEvents.before }).from(auditEvents).where(and(
    eq(auditEvents.action, 'billing.membership.frozen'), eq(auditEvents.targetId, row.id)))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(1);
  const status = (freeze?.before as { status?: string } | null | undefined)?.status;
  return status === 'pending' || status === 'trial';
}
/** Explicit date changes set a new anniversary, except the normal short-year clamp. */
function editedAnniversary(before: Row, nextDueOn?: string): string | null {
  if (before.interval !== 'annual') return null;
  if (nextDueOn === undefined) return before.anniversaryOn;
  const original = before.anniversaryOn;
  const sameAnniversary = original?.slice(5) === nextDueOn.slice(5);
  const clampedLeapDay = original?.slice(5) === '02-29' && nextDueOn.slice(5) === '02-28' &&
    !isCalendarDate(nextDueOn.slice(0, 4) + '-02-29');
  return sameAnniversary || clampedLeapDay ? original : nextDueOn;
}
/** Persisted in the assignment audit so invoice integration can recover after downtime. */
export interface AssignmentBilling {
  /** Plan name at assignment; older recorded assignments may omit it. */
  description?: string;
  firstPeriod: 'prorate_now' | 'next_billing_date';
  startsOn: string; nextDueOn: string; amountCents: number; currency: string; signupFeeCents: number;
  /** Persisted annual anniversary, passed directly to the invoice calculators. */
  annualAnchorOn?: string;
  taxes: { id: string; name: string; rateMillionths: number; inclusive: boolean }[];
}
export interface MembershipOptions {
  scope?: typeof forGym; clock?: Clock; settings?: GymSettingsAccessor;
  /** Database work only: issue first-period/fee invoices in the assigning transaction. Never charge here. */
  onAssigned?: (tx: Transaction, context: MutationContext, membership: c.Membership, billing: AssignmentBilling) => Promise<void>;
}
export function createMembershipService(options: MembershipOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const settings = options.settings ?? gymSettingsAccessor;
  const getRow = async (tx: Transaction, id: string) => catalogMissing((await tx.select().from(memberships).where(eq(memberships.id, id)).for('update'))[0]);
  const getPlan = async (tx: Transaction, id: string, { allowInactive = false }: { allowInactive?: boolean } = {}) => {
    const plan = catalogMissing((await tx.select().from(plans).where(eq(plans.id, id)).for('share'))[0]);
    if (!plan.active && !allowInactive) conflict('Plan is inactive');
    return plan;
  };
  async function assign(context: MutationContext, request: AssignMembership, alignHousehold = false): Promise<c.Membership> {
    c.idSchema.parse(request.id);
    c.assignMembershipRequestSchema.parse({ householdId: request.householdId, memberId: request.memberId, planId: request.planId,
      startsOn: request.startsOn, nextDueOn: request.nextDueOn, firstPeriod: request.firstPeriod, discount: request.discount });
    if (request.discountUseTaken && !request.discount) conflict('A reserved discount use requires a discount');
    const gym = await settings.get(context.gymId);
    return scope(context.gymId, async tx => {
      // Household serialization makes repeated assignment IDs and family alignment deterministic.
      const home = catalogMissing((await tx.select().from(households).where(eq(households.id, request.householdId)).for('update'))[0]);
      const previous = (await tx.select().from(memberships).where(eq(memberships.id, request.id)))[0];
      if (previous) {
        // The enclosing transaction reserved a fresh use: replaying cannot consume it without an application.
        if (request.discountUseTaken) conflict('A reserved discount use cannot replay an assignment');
        const audit = (await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(eq(auditEvents.targetId, request.id), eq(auditEvents.action, 'billing.membership.assigned'))))[0];
        const recorded = audit?.after as { request?: AssignMembership } | undefined;
        if (!recorded?.request || fingerprint(recorded.request) !== fingerprint(request)) conflict('Assignment ID reused with different parameters');
        return present(tx, previous);
      }
      const member = catalogMissing((await tx.select().from(members).where(and(eq(members.id, request.memberId), eq(members.householdId, home.id))).for('share'))[0]);
      if (member.anonymizedAt) conflict('Erased members cannot receive a membership');
      const plan = await getPlan(tx, request.planId);
      if (plan.currency !== gym.currency) conflict('Currency does not match the gym');
      let nextDueOn = request.nextDueOn;
      if (nextDueOn < request.startsOn) conflict('Billing cannot start before membership starts');
      const trialEndsOn = request.trialEndsOn ?? (plan.trialDays ? trialEnd(request.startsOn, plan.trialDays) : null);
      const status = request.initialStatus ?? (trialEndsOn ? 'trial' : 'pending');
      if (!['pending', 'trial', 'active'].includes(status)) conflict('Invalid initial membership state');
      if (trialEndsOn) {
        c.dateSchema.parse(trialEndsOn);
        if (trialEndsOn <= request.startsOn) conflict('Trial must end after it starts');
      }
      if (status === 'trial' && !trialEndsOn) conflict('Trial end is required');
      let newHousehold = false;
      if (alignHousehold) {
        const live = await tx.select({ status: memberships.status, interval: memberships.interval, nextDueOn: memberships.nextDueOn })
          .from(memberships).where(and(eq(memberships.householdId, home.id), ne(memberships.status, 'cancelled')));
        // A household with no live memberships (new, or returning after cancelling) bills from its join date.
        newHousehold = !live.length;
        // Trial and frozen dates are their own; the household date comes from billable monthly memberships.
        const expected = newHousehold ? request.startsOn : live
          .filter(row => row.interval === 'monthly' && (row.status === 'active' || row.status === 'pending'))
          .map(row => row.nextDueOn).sort().find(date => date >= request.startsOn) ?? householdNextDate(request.startsOn, home.billingDay);
        if (nextDueOn !== expected) conflict(newHousehold ? 'A new household starts billing on its join date' : 'Use the household next billing date');
      }
      // A staff-assigned trial is first due when it ends; off the billing day, the engine bills a stub up to it.
      // Internal callers (imports) keep a later explicit date.
      if (trialEndsOn && (alignHousehold || nextDueOn < trialEndsOn)) nextDueOn = trialEndsOn;
      if (newHousehold) {
        // The first bill (after any trial) sets the billing day, so later cycles stay a full period apart.
        const billingDay = Number(nextDueOn.slice(8));
        if (billingDay !== home.billingDay) {
          const guard = revisionGuard(households.revision, home.revision);
          assertRevised(await tx.update(households).set({ billingDay, revision: guard.next })
            .where(and(eq(households.id, home.id), guard.matches)).returning({ id: households.id }));
          await catalogAudit(tx, context, clock, 'billing.household.anchor_set', 'household', home.id,
            { billingDay: home.billingDay, revision: home.revision }, { billingDay, revision: home.revision + 1 });
        }
      }
      const row = catalogMissing((await tx.insert(memberships).values({ id: request.id, gymId: context.gymId,
        householdId: home.id, memberId: member.id, planId: plan.id, amountCents: plan.amountCents, currency: plan.currency,
        interval: plan.interval, status, startsOn: request.startsOn, nextDueOn, trialEndsOn,
        anniversaryOn: plan.interval === 'annual' ? nextDueOn : null,
        commitmentEndsOn: plan.commitmentMonths === null ? null : addCalendarMonths(request.startsOn, plan.commitmentMonths), createdAt: clock.now() }).returning())[0]);
      const attached = await planTaxes(tx, plan.id);
      const billing: AssignmentBilling = { description: plan.name, firstPeriod: request.firstPeriod, startsOn: request.startsOn, nextDueOn,
        ...(row.anniversaryOn === null ? {} : { annualAnchorOn: row.anniversaryOn }),
        amountCents: plan.amountCents, currency: plan.currency, signupFeeCents: plan.signupFeeCents, taxes: attached };
      if (request.discount) {
        const resolved = await resolveDiscount(tx, request.discount, { planIds: [plan.id], timezone: gym.timezone, clock,
          ...(request.discountUseTaken ? { useTaken: true } : {}) });
        const applied = await applyDiscount(tx, context, clock, resolved, row, request.discountUseTaken);
        if (applied.waivesSignupFee) billing.signupFeeCents = 0;
      }
      const result = await present(tx, row);
      await catalogAudit(tx, context, clock, 'billing.membership.assigned', 'membership', row.id, undefined, { request, membership: result, billing });
      await options.onAssigned?.(tx, context, result, billing);
      if (status === 'active') await markLeadWon(tx, { ...context, memberId: member.id, now: clock.now() });
      // A full first period may have used a discount cycle; return the discount as it now stands, as a replay would.
      return request.discount ? present(tx, row) : result;
    });
  }
  /** Locks the household, then the membership: the order the cycle build takes them in. */
  async function lockForSwitch(tx: Transaction, membershipId: string) {
    const found = catalogMissing((await tx.select({ householdId: memberships.householdId }).from(memberships).where(eq(memberships.id, membershipId)))[0]);
    const home = catalogMissing((await tx.select().from(households).where(eq(households.id, found.householdId)).for('update'))[0]);
    return { row: await getRow(tx, membershipId), home };
  }
  async function saveChanges(tx: Transaction, before: Row, changes: Partial<typeof memberships.$inferInsert>) {
    const guard = revisionGuard(memberships.revision, before.revision);
    const row = assertRevised(await tx.update(memberships).set({ ...changes, revision: guard.next })
      .where(and(eq(memberships.id, before.id), guard.matches)).returning());
    return present(tx, row);
  }
  async function saveEdit(tx: Transaction, context: MutationContext, before: Row, previous: c.Membership,
    changes: Partial<typeof memberships.$inferInsert>, action: string, describe: (after: c.Membership) => unknown = after => after) {
    const after = await saveChanges(tx, before, changes);
    await catalogAudit(tx, context, clock, action, 'membership', before.id, previous, describe(after));
    return after;
  }
  async function edit(context: MutationContext, request: MembershipEdit, action: string,
    change: (tx: Transaction, before: Row, previous: c.Membership) => Promise<Partial<typeof memberships.$inferInsert>>) {
    c.idSchema.parse(request.membershipId); c.revisionSchema.parse(request.revision);
    return scope(context.gymId, async tx => {
      // Serialize sibling activations and assignments before checking the member's remaining trials.
      const { row: before } = await lockForSwitch(tx, request.membershipId);
      if (before.revision !== request.revision) refuseMembership('membership_changed');
      const previous = await present(tx, before);
      const after = await saveEdit(tx, context, before, previous, await change(tx, before, previous), 'billing.membership.' + action);
      if (action === 'activated' || action === 'cancelled') await reconcileTrialMember(tx, context, before.memberId);
      return after;
    });
  }
  /** The caller holds the household lock and has saved the membership's new state. */
  async function reconcileTrialMember(tx: Transaction, context: MutationContext, memberId: string) {
    const [member] = await tx.select().from(members).where(eq(members.id, memberId)).for('update');
    if (!member || member.status !== 'trial' || member.anonymizedAt) return;
    const rows = await tx.select().from(memberships).where(eq(memberships.memberId, memberId));
    if (!rows.some(row => row.status === 'active')) return;
    for (const row of rows) {
      if (row.status === 'trial' || (row.trialEndsOn !== null && await frozenBeforeActive(tx, row))) return;
    }
    const guard = revisionGuard(members.revision, member.revision);
    assertRevised(await tx.update(members).set({ status: 'active', revision: guard.next })
      .where(and(eq(members.id, member.id), guard.matches)).returning({ id: members.id }));
    await catalogAudit(tx, context, clock, 'billing.member.activated', 'member', member.id,
      { status: member.status, revision: member.revision }, { status: 'active', revision: member.revision + 1 });
  }
  const service = {
    assign,
    assignFromCatalog(context: MutationContext, input: c.AssignMembershipRequest) {
      return assign(context, { ...c.assignMembershipRequestSchema.parse(input), id: uuidv7() }, true);
    },
    async setDiscount(context: MutationContext, membershipId: string, input: c.SetMembershipDiscountRequest) {
      const request = c.setMembershipDiscountRequestSchema.parse(input), gym = await settings.get(context.gymId);
      return edit(context, { membershipId, revision: request.revision }, 'discount_set', async (tx, before) => {
        if (before.status === 'cancelled') refuseMembership('membership_cancelled');
        const member = catalogMissing((await tx.select({ anonymizedAt: members.anonymizedAt }).from(members).where(eq(members.id, before.memberId)))[0]);
        if (member.anonymizedAt) refuseMembership('membership_erased');
        const resolved = await resolveDiscount(tx, request.discount, {
          planIds: [before.planId, ...(before.scheduledPlanId ? [before.scheduledPlanId] : [])], timezone: gym.timezone, clock });
        // A signup-fee waiver alone applies only at assignment: it would end the live discount and take a use for nothing.
        if (resolved.row.duration === null) refuseMembership('membership_fee_only');
        await endDiscount(tx, context, clock, membershipId, 'replaced');
        await applyDiscount(tx, context, clock, resolved, before);
        return {};
      });
    },
    async removeDiscount(context: MutationContext, membershipId: string, input: c.RemoveMembershipDiscountRequest) {
      const request = c.removeMembershipDiscountRequestSchema.parse(input);
      return edit(context, { membershipId, revision: request.revision }, 'discount_removed', async (tx, before, previous) => {
        if (before.status === 'cancelled') refuseMembership('membership_cancelled');
        if (!previous.discount) refuseMembership('membership_no_discount');
        await endDiscount(tx, context, clock, membershipId, 'removed');
        return {};
      });
    },
    async get(gymId: string, id: string) { return scope(gymId, async tx => present(tx, await getRow(tx, id))); },
    async list(gymId: string, input: unknown) {
      const query = c.membershipListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        if (query.householdId) catalogMissing((await tx.select({ id: households.id }).from(households).where(eq(households.id, query.householdId)))[0]);
        if (query.memberId) catalogMissing((await tx.select({ id: members.id }).from(members).where(eq(members.id, query.memberId)))[0]);
        const where = and(query.householdId ? eq(memberships.householdId, query.householdId) : undefined,
          query.memberId ? eq(memberships.memberId, query.memberId) : undefined, query.status ? eq(memberships.status, query.status) : undefined,
          query.dueOnOrBefore ? lte(memberships.nextDueOn, query.dueOnOrBefore) : undefined);
        const total = await tx.$count(memberships, where);
        const rows = await tx.select().from(memberships).where(where).orderBy(asc(memberships.nextDueOn), asc(memberships.id)).limit(query.limit).offset(query.offset);
        const applied = await liveDiscounts(tx, rows.map(row => row.id));
        return { data: rows.map(row => serialize(row, presentDiscount(applied.get(row.id)))), pagination: { limit: query.limit, offset: query.offset, total } };
      });
    },
    async activate(context: MutationContext, request: MembershipEdit & { nextDueOn?: string }) {
      const gym = await settings.get(context.gymId);
      return edit(context, request, 'activated', async (tx, before) => {
        if (!['pending', 'trial', 'frozen'].includes(before.status)) conflict('Membership cannot be activated');
        // Take the member lock before lead work, matching attendance's member/lead lock order.
        await tx.select({ id: members.id }).from(members).where(eq(members.id, before.memberId)).for('update');
        let due = request.nextDueOn ?? before.nextDueOn;
        c.dateSchema.parse(due);
        if (due < before.startsOn) conflict('Billing cannot start before membership starts');
        const anniversaryOn = editedAnniversary(before, request.nextDueOn);
        if (before.status === 'frozen') {
          const home = catalogMissing((await tx.select().from(households).where(eq(households.id, before.householdId)))[0]);
          const today = localDate(clock.now(), gym.timezone);
          if (request.nextDueOn !== undefined && due < before.nextDueOn) conflict('Resume must preserve the skipped cycle');
          const anchor = before.interval === 'annual' ? Number(due.slice(8)) : home.billingDay;
          // Cycles from a scheduled resume date on are owed, even if this runs late (downtime, a late staff resume).
          const owedFrom = before.resumesOn !== null && before.resumesOn < today ? before.resumesOn : today;
          while (due < owedFrom) due = advanceDue(due, before.interval as c.BillingInterval, anchor, anniversaryOn);
        }
        if (before.status === 'pending' || before.status === 'trial' || await frozenBeforeActive(tx, before))
          await markLeadWon(tx, { ...context, memberId: before.memberId, now: clock.now() });
        return { status: 'active', nextDueOn: due, anniversaryOn, frozenAt: null, resumesOn: null };
      });
    },
    async freeze(context: MutationContext, request: MembershipEdit & { resumesOn?: string | null }) {
      const gym = await settings.get(context.gymId);
      return edit(context, request, 'frozen', async (tx, before) => {
        if (!['active', 'trial'].includes(before.status)) conflict('Membership cannot be frozen');
        const today = localDate(clock.now(), gym.timezone);
        if (request.resumesOn != null && c.dateSchema.parse(request.resumesOn) <= today) conflict('Resume date must be in the future');
        const home = catalogMissing((await tx.select().from(households).where(eq(households.id, before.householdId)))[0]);
        const anchor = before.interval === 'annual' ? Number(before.nextDueOn.slice(8)) : home.billingDay;
        let nextDueOn = advanceDue(before.nextDueOn, before.interval as c.BillingInterval, anchor, before.anniversaryOn);
        while (request.resumesOn && nextDueOn < request.resumesOn) nextDueOn = advanceDue(nextDueOn, before.interval as c.BillingInterval, anchor, before.anniversaryOn);
        return { status: 'frozen', frozenAt: clock.now(), resumesOn: request.resumesOn ?? null, nextDueOn };
      });
    },
    cancel(context: MutationContext, request: MembershipEdit) {
      return edit(context, request, 'cancelled', async (tx, before) => {
        if (before.status === 'cancelled') conflict('Membership is already cancelled');
        await endDiscount(tx, context, clock, before.id, 'removed');
        return { status: 'cancelled', cancelledAt: clock.now(), resumesOn: null, ...clearedSwitch(before) };
      });
    },
    /**
     * Switches a membership to another plan. `next_billing_date` schedules the switch for the next due date, and the
     * cycle build applies it. `now` switches at once: an upgrade takes the new price and issues the proration invoice for
     * the days left in the current period (database work only: the route collects it after commit), and a downgrade or
     * equal switch keeps the current price until the next due date. A request ID already recorded for this membership
     * replays its result (before the revision check, so a retry after a lost response replays), and with other
     * parameters conflicts. A new switch replaces a scheduled one.
     */
    async switchPlan(context: MutationContext, input: SwitchPlanRequest): Promise<c.MembershipSwitchResult> {
      const parsed = switchPlanRequestSchema.safeParse(input);
      if (!parsed.success) throw new AppError('invalid_request', 'Invalid plan switch request');
      const request = parsed.data;
      const recorded: RecordedSwitchRequest = { requestId: request.requestId, planId: request.planId, timing: request.timing,
        override: request.override !== undefined };
      const gym = await settings.get(context.gymId);
      return scope(context.gymId, async tx => {
        const { row: before, home } = await lockForSwitch(tx, request.membershipId);
        const replay = await recordedSwitch(tx, before.id, request.requestId);
        if (replay) {
          if (!sameSwitchRequest(replay.request, recorded)) conflict('Request ID reused with different parameters');
          return { membership: replay.membership, invoiceId: replay.invoiceId };
        }
        if (before.revision !== request.revision) refuseMembership('membership_changed');
        // switchTerms owns refusal precedence for both switch and preview.
        const plan = await getPlan(tx, request.planId, { allowInactive: true });
        const member = catalogMissing((await tx.select({ anonymizedAt: members.anonymizedAt }).from(members).where(eq(members.id, before.memberId)))[0]);
        const today = localDate(clock.now(), gym.timezone);
        const { kind, overrideUsed } = checkSwitch(before, member, plan, request, today);
        // Only a reason the commitment needed is kept.
        const reason = overrideUsed ? request.override?.reason ?? null : null;
        const previous = await present(tx, before);
        if (request.timing === 'next_billing_date') {
          const after = await saveEdit(tx, context, before, previous, scheduledSwitch(before, plan, reason), switchScheduledAction,
            (membership): SwitchScheduledAudit => ({ request: recorded, overrideUsed, membership }));
          return { membership: after, invoiceId: null };
        }
        checkNow(before, plan, today);
        // Quoted from the membership before the switch: the difference against what the current period was billed at.
        const invoice = kind === 'upgrade' ? issuable(await prorateNow(tx, home, before, previous, plan, today)) : null;
        await switchAppliedDiscount(tx, context, clock, before.id, plan.id);
        // Issue after saving the new price so the invoice's immutable membership pricing snapshot matches it.
        const after = await saveChanges(tx, before, switchedNow(before, plan, kind, reason));
        const invoiceId = invoice ? await issue(tx, context, clock, invoice) : null;
        const audit: PlanSwitchedNowAudit = { request: recorded, overrideUsed, kind, invoiceId, membership: after };
        await catalogAudit(tx, context, clock, planSwitchedAction, 'membership', before.id, previous, audit);
        return { membership: after, invoiceId };
      });
    },
    /** What a switch would do, without a lock or a write; the same refusals as the switch, except the commitment. */
    async previewSwitch(gymId: string, membershipId: string, input: c.MembershipSwitchPreviewQuery): Promise<c.MembershipSwitchPreview> {
      const parsed = c.membershipSwitchPreviewQuerySchema.safeParse(input);
      if (!parsed.success || !c.idSchema.safeParse(membershipId).success) throw new AppError('invalid_request', 'Invalid plan switch preview');
      const query = parsed.data;
      const gym = await settings.get(gymId);
      return scope(gymId, async tx => {
        const row = catalogMissing((await tx.select().from(memberships).where(eq(memberships.id, membershipId)))[0]);
        const plan = catalogMissing((await tx.select().from(plans).where(eq(plans.id, query.planId)))[0]);
        const member = catalogMissing((await tx.select({ anonymizedAt: members.anonymizedAt }).from(members).where(eq(members.id, row.memberId)))[0]);
        const home = catalogMissing((await tx.select().from(households).where(eq(households.id, row.householdId)))[0]);
        return switchPreview(tx, home, row, await present(tx, row), member, plan, query.timing, localDate(clock.now(), gym.timezone));
      });
    },
    /**
     * Cancels a plan switch that hasn't applied yet, with its override reason. A price change scheduled on the current
     * plan (a downgrade now's, which cancelling would leave the new plan at the old price, or a plan price change) isn't
     * cancelled here. A price edit replaces it instead.
     */
    async cancelScheduledSwitch(context: MutationContext, input: CancelScheduledSwitchRequest): Promise<c.Membership> {
      const parsed = cancelScheduledSwitchRequestSchema.safeParse(input);
      if (!parsed.success) throw new AppError('invalid_request', 'Invalid request');
      const request = parsed.data;
      return edit(context, request, 'switch_cancelled', async (_tx, before) => {
        if (before.scheduledPlanId === null) throw new AppError('conflict', 'No plan switch is scheduled', { reason: ['none_scheduled'] });
        if (before.scheduledPlanId === before.planId)
          refuse('price_change', 'A scheduled price change isn\'t cancelled here; change the price instead');
        return clearedSwitch(before);
      });
    },
    /**
     * Changes the price or the next due date. A plan or interval changes only through `switchPlan`, so its rules hold.
     * A price edit replaces a scheduled price change (keeping the reason of the switch that left it) and is refused while
     * a plan switch is scheduled, whose quoted price would overwrite it (`switch_scheduled`). A due date moved before a
     * scheduled change's date takes the change with it, so it still applies at the next billing, except a plan price change
     * (`scheduled_origin` `price_change`): it keeps its date, the one its notice gave. A change scheduled before the
     * origin was recorded follows the switch rule.
     */
    async update(context: MutationContext, request: UpdateMembership): Promise<c.Membership> {
      // Reject obsolete fields even from untyped/internal callers; the lifecycle interface no longer offers them.
      const { membershipId, planId, interval, ...input } = request as UpdateMembership & { planId?: unknown; interval?: unknown };
      if (planId !== undefined || interval !== undefined)
        throw new AppError('invalid_request', 'Switch plans to change a membership\'s plan or billing interval');
      const changes = c.updateMembershipRequestSchema.parse(input);
      return edit(context, { membershipId, revision: changes.revision }, 'updated', async (_tx, before) => {
        if (before.status === 'cancelled') conflict('Cancelled membership cannot be edited');
        if (changes.price && changes.price.currency !== before.currency) conflict('Currency does not match');
        if (changes.nextDueOn && changes.nextDueOn < before.startsOn) conflict('Billing cannot start before membership starts');
        const priceOnly = before.scheduledPlanId !== null && before.scheduledPlanId === before.planId;
        if (changes.price && before.scheduledPlanId !== null && !priceOnly)
          refuse('switch_scheduled', 'A plan switch is scheduled; cancel it before changing the price');
        const replaced = changes.price && priceOnly;
        return { ...(changes.price ?? {}), ...(changes.nextDueOn ? { nextDueOn: changes.nextDueOn } : {}),
          ...(replaced ? unscheduled : rescheduledSwitch(before, changes.nextDueOn)),
          anniversaryOn: editedAnniversary(before, changes.nextDueOn) };
      });
    },
    /** Kept for the lifecycle interface: schedules a switch to the plan on the next billing date, replacing a scheduled one. */
    async changePlan(context: MutationContext, request: MembershipEdit & { planId: string }): Promise<c.Membership> {
      return (await service.switchPlan(context, { membershipId: request.membershipId, revision: request.revision, requestId: uuidv7(),
        planId: request.planId, timing: 'next_billing_date' })).membership;
    },
    /** Durable dates are the schedule: process at most a bounded page, committing one membership at a time. */
    async processDates(gymId: string, timezone: string, limit = 100): Promise<number> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid page size');
      const today = localDate(clock.now(), timezone);
      let processed = 0;
      let cursor: string | undefined;
      for (;;) {
        const candidates = await scope(gymId, tx => tx.select().from(memberships).where(and(
          cursor ? gt(memberships.id, cursor) : undefined,
          or(and(eq(memberships.status, 'trial'), lte(memberships.trialEndsOn, today)),
            and(eq(memberships.status, 'frozen'), lte(memberships.resumesOn, today)))))
          .orderBy(asc(memberships.id)).limit(limit));
        for (const row of candidates) {
          try { await service.activate({ gymId, actor: { kind: 'system' } }, { membershipId: row.id, revision: row.revision }); processed++; }
          catch (error) { if (!(error instanceof AppError && error.code === 'conflict')) throw error; }
        }
        if (candidates.length < limit) break;
        cursor = candidates[candidates.length - 1]!.id;
      }
      return processed;
    },
  } satisfies MembershipLifecycle & Record<string, unknown>;
  return service;
}
export type MembershipService = ReturnType<typeof createMembershipService>;
