// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray } from 'drizzle-orm';
import { auditEvents, memberships, plans, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import type { z } from 'zod';
import * as c from '@plaingym/shared/contracts';
import { catalogAudit } from './catalog.js';
import { switchAppliedDiscount } from './discounts/apply.js';
import { switchRequestId } from './memberships.plan-change.query.js';

type Row = typeof memberships.$inferSelect;
type Plan = typeof plans.$inferSelect;

export const switchScheduledAction = 'billing.membership.switch_scheduled';
export const switchCancelledAction = 'billing.membership.switch_cancelled';
/** Audited by a switch made now (with its request) and by the cycle build applying a scheduled switch (without one). */
export const planSwitchedAction = 'billing.membership.plan_switched';

export const switchPlanRequestSchema = c.switchMembershipPlanRequestSchema.extend({ membershipId: c.idSchema });
export type SwitchPlanRequest = z.input<typeof switchPlanRequestSchema>;
export const cancelScheduledSwitchRequestSchema = c.cancelMembershipSwitchRequestSchema.extend({ membershipId: c.idSchema });
export type CancelScheduledSwitchRequest = z.input<typeof cancelScheduledSwitchRequestSchema>;
/** What the audit records of a switch request: never the override reason, which stays on the membership. */
export interface RecordedSwitchRequest { requestId: string; planId: string; timing: c.PlanSwitchTiming; override: boolean }
export interface SwitchScheduledAudit { request: RecordedSwitchRequest; overrideUsed: boolean; membership: c.Membership }
/** A switch made now: its kind and the proration invoice it issued, if any. */
export interface PlanSwitchedNowAudit extends SwitchScheduledAudit { kind: SwitchKind; invoiceId: string | null }

export type SwitchKind = c.PlanSwitchKind;
const perYear = (amountCents: number, interval: string) => amountCents * (interval === 'monthly' ? 12 : 1);
/** Compares prices per year (a monthly price × 12), so a change of interval compares like for like. */
export function switchKind(current: { amountCents: number; interval: string }, next: { amountCents: number; interval: string }): SwitchKind {
  const from = perYear(current.amountCents, current.interval), to = perYear(next.amountCents, next.interval);
  return to < from ? 'downgrade' : to > from ? 'upgrade' : 'equal';
}
/**
 * A downgrade that takes effect before the commitment ends needs an override; one that takes effect on or after its
 * last day doesn't.
 */
export function commitmentBlocks(kind: SwitchKind, commitmentEndsOn: string | null, effectiveOn: string): boolean {
  return kind === 'downgrade' && commitmentEndsOn !== null && commitmentEndsOn > effectiveOn;
}
/** The day a switch takes effect: today for one made now, otherwise the next due date, when the cycle build applies it. */
export function switchEffectiveOn(row: Row, timing: c.PlanSwitchTiming, today: string): string {
  return timing === 'now' ? today : row.nextDueOn;
}

export function refuse(reason: string, message: string): never { throw new AppError('conflict', message, { reason: [reason] }); }
/**
 * The switch rules for a membership and its member that no override lifts, and whether the commitment blocks the
 * switch on the day it takes effect. The preview reports the block; the switch refuses it without an override
 * (`checkSwitch`).
 */
export function switchTerms(row: Row, member: { anonymizedAt: Date | null }, plan: Plan, timing: c.PlanSwitchTiming, today: string) {
  if (row.status === 'cancelled') refuse('cancelled', 'A cancelled membership cannot switch plans');
  if (member.anonymizedAt) refuse('erased', 'An erased member cannot switch plans');
  if (!plan.active) refuse('plan_inactive', 'Plan is inactive');
  if (plan.currency !== row.currency) refuse('currency', 'Currency does not match');
  if (plan.id === row.planId) refuse('same_plan', 'The membership is already on this plan');
  const kind = switchKind(row, plan);
  return { kind, commitmentBlocks: commitmentBlocks(kind, row.commitmentEndsOn, switchEffectiveOn(row, timing, today)) };
}
/**
 * The switch rules, checked after the locks, replay and revision. `overrideUsed` is true only when the commitment
 * blocked the switch and the request's override let it through.
 */
export function checkSwitch(row: Row, member: { anonymizedAt: Date | null }, plan: Plan,
  request: { timing: c.PlanSwitchTiming; override?: { reason: string } | undefined }, today: string): { kind: SwitchKind; overrideUsed: boolean } {
  const { kind, commitmentBlocks: blocked } = switchTerms(row, member, plan, request.timing, today);
  if (blocked && !request.override) refuse('commitment', 'A downgrade before the commitment ends needs an override reason');
  return { kind, overrideUsed: blocked };
}
/** Where a scheduled change came from (`memberships.scheduled_origin`); null on a change scheduled before it was recorded. */
export type ScheduledOrigin = 'switch' | 'downgrade' | 'price_change';
/**
 * The columns a scheduled switch sets: the plan, its price and interval now, and the membership's next due date. A
 * downgrade now schedules the same columns on the new plan, as the price it keeps until then (`downgrade`).
 */
export function scheduledSwitch(row: Row, plan: Plan, overrideReason: string | null, origin: ScheduledOrigin = 'switch') {
  return { scheduledPlanId: plan.id, scheduledAmountCents: plan.amountCents, scheduledInterval: plan.interval,
    scheduledOn: row.nextDueOn, scheduledOrigin: origin, switchOverrideReason: overrideReason };
}
/**
 * The four scheduled columns and their origin, cleared. Erasure's cancel and a price edit that replaces a price change
 * use them too.
 */
export const unscheduled = { scheduledPlanId: null, scheduledAmountCents: null, scheduledInterval: null, scheduledOn: null,
  scheduledOrigin: null } as const;
/**
 * Clears a switch that hasn't applied yet, with its override reason. A reason left with no switch scheduled records
 * the last applied switch and stays until the next switch is scheduled (or the member is erased). A price change left
 * by a switch made now (scheduled on the current plan) belongs to a switch that has applied, so its reason stays.
 */
export function clearedSwitch(row: Row) {
  if (row.scheduledPlanId === null) return {};
  return row.scheduledPlanId === row.planId ? unscheduled : { ...unscheduled, switchOverrideReason: null };
}
/**
 * The columns a switch made now sets. An upgrade takes the new plan's price at once (the proration invoice charges the
 * days left). A downgrade or equal switch keeps the current price until the next due date, through a price change
 * scheduled on the new plan, which the cycle build applies like any scheduled change. Either replaces a scheduled
 * switch, and keeps only an override reason the commitment needed.
 */
export function switchedNow(row: Row, plan: Plan, kind: SwitchKind, overrideReason: string | null) {
  const priceLater = kind !== 'upgrade' && plan.amountCents !== row.amountCents;
  return { planId: plan.id, ...(kind === 'upgrade' ? { amountCents: plan.amountCents } : {}),
    ...(priceLater ? scheduledSwitch(row, plan, overrideReason, 'downgrade') : { ...unscheduled, switchOverrideReason: overrideReason }) };
}
/**
 * The recorded result of a switch request on this membership, or undefined when the request ID is new: a scheduled
 * switch's audit, or a switch made now's (the cycle build's applied switches carry no request).
 */
export async function recordedSwitch(tx: Transaction, membershipId: string, requestId: string) {
  const [event] = await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
    inArray(auditEvents.action, [switchScheduledAction, planSwitchedAction]), eq(auditEvents.targetId, membershipId),
    eq(switchRequestId(), requestId))).limit(1);
  const found = event?.after as Partial<PlanSwitchedNowAudit> | undefined;
  return found && { request: found.request!, membership: found.membership!, invoiceId: found.invoiceId ?? null };
}
export function sameSwitchRequest(recorded: RecordedSwitchRequest, request: RecordedSwitchRequest): boolean {
  return recorded.planId === request.planId && recorded.timing === request.timing && recorded.override === request.override;
}

/**
 * Applies an active membership's scheduled switch when its date is on or before the membership's next due date. Call
 * it inside the cycle build's transaction with the membership row locked, and price the row it returns. A frozen,
 * pending or trial membership keeps its switch until it is billed as active. A scheduled change to the current plan
 * changes only the price. A switch to a plan archived after it was scheduled still applies, at its quoted price, as an
 * archived plan keeps the members already on it.
 */
export async function applyScheduledSwitch(tx: Transaction, row: Row, clock: Clock): Promise<Row> {
  if (row.status !== 'active' || row.scheduledPlanId === null || row.scheduledAmountCents === null ||
    row.scheduledInterval === null || row.scheduledOn === null || row.scheduledOn > row.nextDueOn) return row;
  const samePlan = row.scheduledPlanId === row.planId;
  if (!samePlan) await switchAppliedDiscount(tx, { gymId: row.gymId, actor: { kind: 'system' } }, clock, row.id, row.scheduledPlanId);
  const interval = samePlan ? row.interval : row.scheduledInterval;
  // An annual membership keeps its anniversary (a February 29 one included); one that becomes annual starts it on this
  // due date; a monthly one has none.
  const anniversaryOn = interval !== 'annual' ? null : row.interval === 'annual' ? row.anniversaryOn ?? row.nextDueOn : row.nextDueOn;
  const after = (await tx.update(memberships).set({ planId: row.scheduledPlanId, amountCents: row.scheduledAmountCents,
    interval, anniversaryOn, ...unscheduled,
    revision: row.revision + 1 }).where(and(eq(memberships.id, row.id), eq(memberships.revision, row.revision))).returning())[0];
  if (!after) throw new Error('A locked membership changed during the cycle build');
  const terms = (value: Row) => ({ planId: value.planId, amountCents: value.amountCents, interval: value.interval,
    anniversaryOn: value.anniversaryOn, revision: value.revision });
  await catalogAudit(tx, { gymId: row.gymId, actor: { kind: 'system' } }, clock, planSwitchedAction, 'membership', row.id,
    terms(row), { ...terms(after), dueOn: row.nextDueOn, scheduledOn: row.scheduledOn });
  return after;
}
