// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { auditEvents, memberships, plans, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { z } from 'zod';
import * as c from '@plaingym/shared/contracts';
import { catalogAudit } from './catalog.js';

type Row = typeof memberships.$inferSelect;
type Plan = typeof plans.$inferSelect;

export const switchScheduledAction = 'billing.membership.switch_scheduled';
export const switchCancelledAction = 'billing.membership.switch_cancelled';
export const planSwitchedAction = 'billing.membership.plan_switched';

/** Only the next-billing-date timing exists so far. */
export const switchPlanRequestSchema = z.strictObject({
  membershipId: c.idSchema,
  revision: c.revisionSchema,
  requestId: c.idSchema,
  planId: c.idSchema,
  timing: z.literal('next_billing_date'),
  override: z.strictObject({ reason: z.string().trim().min(1).max(500) }).optional(),
});
export type SwitchPlanRequest = z.input<typeof switchPlanRequestSchema>;
export const cancelScheduledSwitchRequestSchema = z.strictObject({ membershipId: c.idSchema, revision: c.revisionSchema });
export type CancelScheduledSwitchRequest = z.input<typeof cancelScheduledSwitchRequestSchema>;
/** What the audit records of a switch request: never the override reason, which stays on the membership. */
export interface RecordedSwitchRequest { requestId: string; planId: string; timing: string; override: boolean }
export interface SwitchScheduledAudit { request: RecordedSwitchRequest; overrideUsed: boolean; membership: c.Membership }

export type SwitchKind = 'upgrade' | 'downgrade' | 'equal';
const perYear = (amountCents: number, interval: string) => amountCents * (interval === 'monthly' ? 12 : 1);
/** Compares prices per year (a monthly price × 12), so a change of interval compares like for like. */
export function switchKind(current: { amountCents: number; interval: string }, next: { amountCents: number; interval: string }): SwitchKind {
  const from = perYear(current.amountCents, current.interval), to = perYear(next.amountCents, next.interval);
  return to < from ? 'downgrade' : to > from ? 'upgrade' : 'equal';
}
/** A downgrade before the commitment ends needs an override; on or after its last day it doesn't. */
export function commitmentBlocks(kind: SwitchKind, commitmentEndsOn: string | null, today: string): boolean {
  return kind === 'downgrade' && commitmentEndsOn !== null && commitmentEndsOn > today;
}

function refuse(reason: string, message: string): never { throw new AppError('conflict', message, { reason: [reason] }); }
/**
 * The switch rules for a membership and its member, checked after the locks, replay and revision. `overrideUsed` is
 * true only when the commitment blocked the switch and the request's override let it through.
 */
export function checkSwitch(row: Row, member: { anonymizedAt: Date | null }, plan: Plan,
  request: { override?: { reason: string } | undefined }, today: string): { kind: SwitchKind; overrideUsed: boolean } {
  if (row.status === 'cancelled') refuse('cancelled', 'A cancelled membership cannot switch plans');
  if (member.anonymizedAt) refuse('erased', 'An erased member cannot switch plans');
  if (!plan.active) refuse('plan_inactive', 'Plan is inactive');
  if (plan.currency !== row.currency) refuse('currency', 'Currency does not match');
  if (plan.id === row.planId) refuse('same_plan', 'The membership is already on this plan');
  const kind = switchKind(row, plan), blocked = commitmentBlocks(kind, row.commitmentEndsOn, today);
  if (blocked && !request.override) refuse('commitment', 'A downgrade before the commitment ends needs an override reason');
  return { kind, overrideUsed: blocked };
}
/** The columns a scheduled switch sets: the plan, its price and interval now, and the membership's next due date. */
export function scheduledSwitch(row: Row, plan: Plan, overrideReason: string | null) {
  return { scheduledPlanId: plan.id, scheduledAmountCents: plan.amountCents, scheduledInterval: plan.interval,
    scheduledOn: row.nextDueOn, switchOverrideReason: overrideReason };
}
/**
 * Clears a switch that hasn't applied yet, with its override reason. A reason left with no switch scheduled records
 * the last applied switch and stays until the next switch is scheduled (or the member is erased).
 */
export function clearedSwitch(row: Row) {
  return row.scheduledPlanId === null ? {} : { scheduledPlanId: null, scheduledAmountCents: null, scheduledInterval: null,
    scheduledOn: null, switchOverrideReason: null };
}
/** The recorded result of a switch request on this membership, or undefined when the request ID is new. */
export async function recordedSwitch(tx: Transaction, membershipId: string, requestId: string) {
  const events = await tx.select({ after: auditEvents.after }).from(auditEvents)
    .where(and(eq(auditEvents.action, switchScheduledAction), eq(auditEvents.targetId, membershipId)));
  return events.map(event => event.after as SwitchScheduledAudit).find(after => after.request.requestId === requestId);
}
export function sameSwitchRequest(recorded: RecordedSwitchRequest, request: RecordedSwitchRequest): boolean {
  return recorded.planId === request.planId && recorded.timing === request.timing && recorded.override === request.override;
}

/**
 * Applies an active membership's scheduled switch when its date is on or before the membership's next due date. Call
 * it inside the cycle build's transaction with the membership row locked, and price the row it returns. A frozen,
 * pending or trial membership keeps its switch until it is billed as active. A scheduled change to the current plan
 * changes only the price.
 */
export async function applyScheduledSwitch(tx: Transaction, row: Row, clock: Clock): Promise<Row> {
  if (row.status !== 'active' || row.scheduledPlanId === null || row.scheduledAmountCents === null ||
    row.scheduledInterval === null || row.scheduledOn === null || row.scheduledOn > row.nextDueOn) return row;
  const samePlan = row.scheduledPlanId === row.planId;
  const interval = samePlan ? row.interval : row.scheduledInterval;
  // An annual membership keeps its anniversary (a February 29 one included); one that becomes annual starts it on this
  // due date; a monthly one has none.
  const anniversaryOn = interval !== 'annual' ? null : row.interval === 'annual' ? row.anniversaryOn ?? row.nextDueOn : row.nextDueOn;
  const after = (await tx.update(memberships).set({ planId: row.scheduledPlanId, amountCents: row.scheduledAmountCents,
    interval, anniversaryOn, scheduledPlanId: null, scheduledAmountCents: null, scheduledInterval: null, scheduledOn: null,
    revision: row.revision + 1 }).where(and(eq(memberships.id, row.id), eq(memberships.revision, row.revision))).returning())[0];
  if (!after) throw new Error('A locked membership changed during the cycle build');
  const terms = (value: Row) => ({ planId: value.planId, amountCents: value.amountCents, interval: value.interval,
    anniversaryOn: value.anniversaryOn, revision: value.revision });
  await catalogAudit(tx, { gymId: row.gymId, actor: { kind: 'system' } }, clock, planSwitchedAction, 'membership', row.id,
    terms(row), { ...terms(after), dueOn: row.nextDueOn, scheduledOn: row.scheduledOn });
  return after;
}
