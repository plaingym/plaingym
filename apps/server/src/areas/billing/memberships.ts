// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, lte, ne, or } from 'drizzle-orm';
import { forGym, memberships, households, members, plans, auditEvents, planTaxRates, taxRates,
  revisionGuard, assertRevised, uuidv7, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { isCalendarDate, localDate } from '@plaingym/shared/time';
import * as c from '@plaingym/shared/contracts';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { MembershipLifecycle, AssignMembership, MembershipEdit, UpdateMembership } from '../../core/interfaces/membership-lifecycle.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { clock as defaultClock } from '../../core/clock.js';
import { gymSettingsAccessor } from '../settings/settings.js';
import { catalogAudit, catalogMissing } from './catalog.js';
import { addCalendarMonths, advanceDue, householdNextDate, trialEnd } from './memberships.calendar.js';

type Row = typeof memberships.$inferSelect;
const present = ({ gymId: _gymId, anniversaryOn: _anniversaryOn, ...row }: Row): c.Membership => c.membershipSchema.parse({ ...row,
  createdAt: row.createdAt.toISOString(), frozenAt: row.frozenAt?.toISOString() ?? null,
  cancelledAt: row.cancelledAt?.toISOString() ?? null });
const conflict = (message: string): never => { throw new AppError('conflict', message); };
/** Explicit date changes set a new anniversary, except the normal short-year clamp. */
function editedAnniversary(before: Row, interval: string, nextDueOn?: string): string | null {
  if (interval !== 'annual') return null;
  if (before.interval !== 'annual') return nextDueOn ?? before.nextDueOn;
  if (nextDueOn === undefined) return before.anniversaryOn;
  const original = before.anniversaryOn;
  const sameAnniversary = original?.slice(5) === nextDueOn.slice(5);
  const clampedLeapDay = original?.slice(5) === '02-29' && nextDueOn.slice(5) === '02-28' &&
    !isCalendarDate(nextDueOn.slice(0, 4) + '-02-29');
  return sameAnniversary || clampedLeapDay ? original : nextDueOn;
}
/** Persisted in the assignment audit so invoice integration can recover after downtime. */
export interface AssignmentBilling {
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
  const getPlan = async (tx: Transaction, id: string) => {
    const plan = catalogMissing((await tx.select().from(plans).where(eq(plans.id, id)).for('share'))[0]);
    if (!plan.active) conflict('Plan is inactive');
    return plan;
  };
  async function assign(context: MutationContext, request: AssignMembership, alignHousehold = false): Promise<c.Membership> {
    c.idSchema.parse(request.id);
    c.assignMembershipRequestSchema.parse({ householdId: request.householdId, memberId: request.memberId, planId: request.planId,
      startsOn: request.startsOn, nextDueOn: request.nextDueOn, firstPeriod: request.firstPeriod });
    const gym = await settings.get(context.gymId);
    return scope(context.gymId, async tx => {
      // Household serialization makes repeated assignment IDs and family alignment deterministic.
      const home = catalogMissing((await tx.select().from(households).where(eq(households.id, request.householdId)).for('update'))[0]);
      const previous = (await tx.select().from(memberships).where(eq(memberships.id, request.id)))[0];
      if (previous) {
        const audit = (await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(eq(auditEvents.targetId, request.id), eq(auditEvents.action, 'billing.membership.assigned'))))[0];
        const recorded = audit?.after as { request?: AssignMembership } | undefined;
        if (!recorded?.request || JSON.stringify(recorded.request, Object.keys(recorded.request).sort()) !== JSON.stringify(request, Object.keys(request).sort())) conflict('Assignment ID reused with different parameters');
        return present(previous);
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
      const attached = await tx.select({ id: taxRates.id, name: taxRates.name, rateMillionths: taxRates.rateMillionths, inclusive: taxRates.inclusive })
        .from(planTaxRates).innerJoin(taxRates, eq(taxRates.id, planTaxRates.taxRateId)).where(eq(planTaxRates.planId, plan.id)).orderBy(asc(taxRates.id));
      const billing: AssignmentBilling = { firstPeriod: request.firstPeriod, startsOn: request.startsOn, nextDueOn,
        ...(row.anniversaryOn === null ? {} : { annualAnchorOn: row.anniversaryOn }),
        amountCents: plan.amountCents, currency: plan.currency, signupFeeCents: plan.signupFeeCents, taxes: attached };
      const result = present(row);
      await catalogAudit(tx, context, clock, 'billing.membership.assigned', 'membership', row.id, undefined, { request, membership: result, billing });
      await options.onAssigned?.(tx, context, result, billing);
      return result;
    });
  }
  async function edit(context: MutationContext, request: MembershipEdit, action: string,
    change: (tx: Transaction, before: Row) => Promise<Partial<typeof memberships.$inferInsert>>) {
    c.idSchema.parse(request.membershipId); c.revisionSchema.parse(request.revision);
    return scope(context.gymId, async tx => {
      const before = await getRow(tx, request.membershipId);
      if (before.revision !== request.revision) conflict('The record changed; reload before saving');
      const changes = await change(tx, before), guard = revisionGuard(memberships.revision, request.revision);
      const after = assertRevised(await tx.update(memberships).set({ ...changes, revision: guard.next })
        .where(and(eq(memberships.id, before.id), guard.matches)).returning());
      await catalogAudit(tx, context, clock, 'billing.membership.' + action, 'membership', before.id, present(before), present(after));
      return present(after);
    });
  }
  const service = {
    assign,
    assignFromCatalog(context: MutationContext, input: c.AssignMembershipRequest) {
      return assign(context, { ...c.assignMembershipRequestSchema.parse(input), id: uuidv7() }, true);
    },
    async get(gymId: string, id: string) { return scope(gymId, async tx => present(await getRow(tx, id))); },
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
        return { data: rows.map(present), pagination: { limit: query.limit, offset: query.offset, total } };
      });
    },
    async activate(context: MutationContext, request: MembershipEdit & { nextDueOn?: string }) {
      const gym = await settings.get(context.gymId);
      return edit(context, request, 'activated', async (tx, before) => {
        if (!['pending', 'trial', 'frozen'].includes(before.status)) conflict('Membership cannot be activated');
        let due = request.nextDueOn ?? before.nextDueOn;
        c.dateSchema.parse(due);
        if (due < before.startsOn) conflict('Billing cannot start before membership starts');
        const anniversaryOn = editedAnniversary(before, before.interval, request.nextDueOn);
        if (before.status === 'frozen') {
          const home = catalogMissing((await tx.select().from(households).where(eq(households.id, before.householdId)))[0]);
          const today = localDate(clock.now(), gym.timezone);
          if (request.nextDueOn !== undefined && due < before.nextDueOn) conflict('Resume must preserve the skipped cycle');
          const anchor = before.interval === 'annual' ? Number(due.slice(8)) : home.billingDay;
          // Cycles from a scheduled resume date on are owed, even if this runs late (downtime, a late staff resume).
          const owedFrom = before.resumesOn !== null && before.resumesOn < today ? before.resumesOn : today;
          while (due < owedFrom) due = advanceDue(due, before.interval as c.BillingInterval, anchor, anniversaryOn);
        }
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
      return edit(context, request, 'cancelled', async (_tx, before) => {
        if (before.status === 'cancelled') conflict('Membership is already cancelled');
        return { status: 'cancelled', cancelledAt: clock.now(), resumesOn: null };
      });
    },
    update(context: MutationContext, request: UpdateMembership): Promise<c.Membership> {
      const { membershipId, ...input } = request;
      const changes = c.updateMembershipRequestSchema.parse(input);
      return edit(context, { membershipId, revision: changes.revision }, 'updated', async (tx, before) => {
        if (before.status === 'cancelled') conflict('Cancelled membership cannot be edited');
        const plan = changes.planId ? await getPlan(tx, changes.planId) : undefined;
        if (plan && plan.currency !== before.currency || changes.price && changes.price.currency !== before.currency) conflict('Currency does not match');
        if (changes.nextDueOn && changes.nextDueOn < before.startsOn) conflict('Billing cannot start before membership starts');
        const interval = changes.interval ?? plan?.interval ?? before.interval;
        const anniversaryOn = editedAnniversary(before, interval, changes.nextDueOn);
        return { ...(plan ? { planId: plan.id, amountCents: plan.amountCents, currency: plan.currency, interval: plan.interval } : {}),
          ...(changes.price ?? {}), ...(changes.interval ? { interval: changes.interval } : {}),
          ...(changes.nextDueOn ? { nextDueOn: changes.nextDueOn } : {}), anniversaryOn };
      });
    },
    changePlan(context: MutationContext, request: MembershipEdit & { planId: string }): Promise<c.Membership> { return service.update(context, request); },
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
