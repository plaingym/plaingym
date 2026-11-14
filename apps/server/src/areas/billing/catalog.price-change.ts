// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import { assertRevised, auditEvents, forGym, households, members, memberships, plans, revisionGuard,
  type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { localDate } from '@plaingym/shared/time';
import * as c from '@plaingym/shared/contracts';
import { z } from 'zod';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { clock as defaultClock } from '../../core/clock.js';
import { commandDigest } from '../../infra/email/deliveries.js';
import { withJobTransaction, type Jobs, type JobTransaction } from '../../infra/jobs/index.js';
import { gymSettingsAccessor } from '../settings/settings.js';
import type { SmtpResolver } from '../settings/smtp.js';
import { catalogAudit, catalogMissing } from './catalog.js';
import { refuse } from './memberships.plan-change.js';
import { priceNoticeJob, priceNoticePayload, priceNoticeReach } from './memberships.price-notice.js';
import { lockPriceRequest, priceRequestKey, priceResultKey } from './catalog.price-change.query.js';

type Row = typeof memberships.$inferSelect;
type Plan = typeof plans.$inferSelect;
type Reason = c.PlanPriceChangeSkipReason;
type Reach = c.PlanPriceChangeReach;

/** Audited on the plan with the request, in the transaction that changes its price. Its request key is looked up there. */
export const planPriceChangedAction = 'billing.plan.price_changed';
/** Audited on each membership scheduled, with the request key, so a retry never schedules it twice. */
export const priceChangeScheduledAction = 'billing.membership.price_change_scheduled';
/** Audited on the plan once every listed membership was handled, with the result a replay returns. */
export const planPriceChangeAppliedAction = 'billing.plan.price_change_applied';

/** What the plan's audit records of a request; the list is a digest of its sorted membership IDs. */
export interface RecordedPriceChange {
  requestKey: string; planId: string; amountCents: number; effectiveOn: string; notify: boolean;
  memberships: string; count: number;
}
const sameRequest = (a: RecordedPriceChange, b: RecordedPriceChange) => a.planId === b.planId && a.amountCents === b.amountCents
  && a.effectiveOn === b.effectiveOn && a.notify === b.notify && a.memberships === b.memberships && a.count === b.count;


export interface PriceChangeOptions {
  scope?: typeof forGym; clock?: Clock; settings?: GymSettingsAccessor;
  /** Queues the notice job in each chunk's transaction. Without it, an apply with `notify` is `unavailable` before any write. */
  jobs?: Jobs;
  /** Whether the gym can send member email now (the demo outbox always can). Without it, the preview says it can't. */
  smtp?: Pick<SmtpResolver, 'configured'>;
  /** Households a chunk transaction locks at most, and memberships it schedules at most; a household is never split. */
  chunk?: { households: number; memberships: number };
}

const invalid = (message: string): never => { throw new AppError('invalid_request', message); };
const priceStepSchema = z.object({ currency: c.currencySchema, amountCents: z.number() }).superRefine(c.refinePriceStep(['amountCents']));
/** The price must sit on the step of the plan's currency, as `updatePlan` checks it. */
function checkPrice(plan: Plan, amountCents: number) {
  const result = priceStepSchema.safeParse({ currency: plan.currency, amountCents });
  if (!result.success) invalid(result.error.issues[0]!.message);
}
function checkDate(effectiveOn: string, today: string) {
  if (effectiveOn < today) invalid('The price change must start on or after today');
}
/** Why a membership on the plan can't take the change, before any request: a scheduled change, or other terms. */
function blocked(row: Row, plan: Plan): Reason | null {
  if (row.scheduledPlanId !== null) return row.scheduledPlanId === row.planId ? 'price_scheduled' : 'switch_scheduled';
  if (row.currency !== plan.currency || row.interval !== plan.interval) return 'terms';
  return null;
}
const live = and(ne(memberships.status, 'cancelled'), isNull(memberships.cancelledAt));

/**
 * Whether each household's notice can reach its payer, as the notice job decides it: no valid billing address
 * (`no_address`), an erased payer (`payer_erased`), then an opted-out or undeliverable address (`suppressed`).
 */
async function householdReach(tx: Transaction, gymId: string, householdIds: readonly string[]): Promise<Map<string, Reach>> {
  return (await priceNoticeReach(tx, gymId, householdIds)).reach;
}
type Terms = Pick<Row, 'amountCents' | 'interval' | 'scheduledPlanId' | 'scheduledAmountCents' | 'scheduledInterval' | 'scheduledOn' | 'revision'>;
const terms = (row: Terms): Terms => ({ amountCents: row.amountCents, interval: row.interval, scheduledPlanId: row.scheduledPlanId,
  scheduledAmountCents: row.scheduledAmountCents, scheduledInterval: row.scheduledInterval, scheduledOn: row.scheduledOn, revision: row.revision });

/**
 * A plan price change for existing members. The preview lists the plan's memberships with their default ticks; the
 * apply changes the plan's price and schedules F3's price-only change (`applyScheduledSwitch` applies it at the first
 * active cycle due on or after its date, with no proration) on the listed memberships, a few households per short
 * transaction under the cycle build's household-then-membership lock order, queueing one notice job per household in the
 * same transaction. The request key makes a retry resume or replay: it is checked under the plan lock, and on each
 * membership before its revision.
 */
export function createPriceChangeService(options: PriceChangeOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const settings = options.settings ?? gymSettingsAccessor, jobs = options.jobs;
  const { households: chunkHouseholds, memberships: chunkMemberships } = options.chunk ?? { households: 25, memberships: 100 };

  async function recordedRequest(tx: Transaction, requestKey: string) {
    const [event] = await tx.select({ after: auditEvents.after }).from(auditEvents)
      .where(and(eq(auditEvents.action, planPriceChangedAction), eq(priceRequestKey(), requestKey))).limit(1);
    return (event?.after as { request?: RecordedPriceChange } | undefined)?.request;
  }
  async function recordedResult(tx: Transaction, planId: string, requestKey: string) {
    const [event] = await tx.select({ after: auditEvents.after }).from(auditEvents)
      .where(and(eq(auditEvents.action, planPriceChangeAppliedAction), eq(auditEvents.targetId, planId), eq(priceResultKey(), requestKey))).limit(1);
    return (event?.after as { result?: c.PlanPriceChangeResult } | undefined)?.result;
  }
  const lockPlan = async (tx: Transaction, planId: string) =>
    catalogMissing((await tx.select().from(plans).where(eq(plans.id, planId)).for('update'))[0], 'Plan not found');

  interface Chunk { householdIds: string[]; membershipIds: string[] }
  interface Outcome { scheduled: string[]; skipped: { id: string; reason: Reason }[]; notified: number; reach: Reach[] }
  /** One chunk: locks its households, then their memberships, and schedules each listed membership that can move. */
  async function schedule(transaction: JobTransaction, context: MutationContext, request: z.infer<typeof c.applyPlanPriceChangeRequestSchema>,
    planId: string, timezone: string, chunk: Chunk, revisions: ReadonlyMap<string, number>): Promise<Outcome> {
    const { tx } = transaction;
    await tx.select({ id: households.id }).from(households).where(inArray(households.id, chunk.householdIds))
      .orderBy(asc(households.id)).for('update');
    const rows = await tx.select().from(memberships).where(inArray(memberships.id, chunk.membershipIds))
      .orderBy(asc(memberships.id)).for('update');
    const plan = catalogMissing((await tx.select().from(plans).where(eq(plans.id, planId)))[0], 'Plan not found');
    const erased = new Set((await tx.select({ id: members.id, anonymizedAt: members.anonymizedAt }).from(members)
      .where(inArray(members.id, rows.map(row => row.memberId)))).filter(member => member.anonymizedAt).map(member => member.id));
    // Checked before the revision: a membership this request already scheduled has moved on since its listed revision.
    const keyed = new Map((await tx.select({ targetId: auditEvents.targetId, after: auditEvents.after }).from(auditEvents)
      .where(and(eq(auditEvents.action, priceChangeScheduledAction), inArray(auditEvents.targetId, chunk.membershipIds))))
      .filter(event => {
        const after = event.after as { requestKey?: string; planId?: string } | null;
        return after?.requestKey === request.requestKey && after.planId === planId;
      }).map(event => [event.targetId, event.after as Terms]));
    const outcome: Outcome = { scheduled: [], skipped: [], notified: 0, reach: [] };
    const fresh = new Map<string, string[]>(), moved = new Set<string>();
    const lockedHouseholds = new Set(chunk.householdIds);
    for (const row of rows) {
      if (keyed.has(row.id)) {
        if (row.planId === planId && row.status !== 'cancelled' && row.cancelledAt === null && !erased.has(row.memberId)
          && row.scheduledPlanId === planId && row.scheduledAmountCents === request.amountCents
          && row.scheduledInterval === keyed.get(row.id)!.scheduledInterval
          && row.scheduledOn === request.effectiveOn && row.scheduledOrigin === 'price_change' && lockedHouseholds.has(row.householdId)) {
          outcome.scheduled.push(row.id); moved.add(row.householdId);
        } else outcome.skipped.push({ id: row.id, reason: 'changed' });
        continue;
      }
      const changed = row.planId !== planId || row.status === 'cancelled' || row.cancelledAt !== null || erased.has(row.memberId)
        || row.revision !== revisions.get(row.id) || !lockedHouseholds.has(row.householdId);
      const reason: Reason | null = changed ? 'changed' : blocked(row, plan);
      if (reason) { outcome.skipped.push({ id: row.id, reason }); continue; }
      const guard = revisionGuard(memberships.revision, row.revision);
      const after = assertRevised(await tx.update(memberships).set({ scheduledPlanId: planId, scheduledAmountCents: request.amountCents,
        scheduledInterval: row.interval, scheduledOn: request.effectiveOn, scheduledOrigin: 'price_change', revision: guard.next })
        .where(and(eq(memberships.id, row.id), guard.matches)).returning());
      await catalogAudit(tx, context, clock, priceChangeScheduledAction, 'membership', row.id, terms(row),
        { requestKey: request.requestKey, planId, ...terms(after) });
      outcome.scheduled.push(row.id); moved.add(row.householdId);
      fresh.set(row.householdId, [...fresh.get(row.householdId) ?? [], row.id]);
    }
    if (request.notify) {
      // Only the run that scheduled a household's memberships queues its notice, so it commits with them, once.
      for (const [householdId, membershipIds] of fresh) {
        const payload = priceNoticePayload.parse({ requestKey: request.requestKey, planId, householdId, membershipIds: membershipIds.sort(),
          amountCents: request.amountCents, currency: plan.currency, effectiveOn: request.effectiveOn });
        await jobs!.enqueue(priceNoticeJob, payload, { gymId: transaction.gymId, timezone,
          idempotencyKey: `plan-price:${request.requestKey}:${householdId}`, maxAttempts: 12 }, transaction);
      }
    }
    const reach = await householdReach(tx, context.gymId, [...moved]);
    outcome.reach = [...moved].map(id => reach.get(id) ?? 'no_address');
    outcome.notified = request.notify ? outcome.reach.filter(value => value === 'ok').length : 0;
    return outcome;
  }

  return {
    async preview(gymId: string, planId: string, input: unknown): Promise<c.PlanPriceChangePreview> {
      const parsed = c.planPriceChangePreviewQuerySchema.safeParse(input);
      if (!parsed.success || !c.idSchema.safeParse(planId).success) return invalid('Invalid price change preview');
      const query = parsed.data, gym = await settings.get(gymId);
      const today = localDate(clock.now(), gym.timezone);
      checkDate(query.effectiveOn, today);
      const canEmail = gym.memberEmailsEnabled && Boolean(await options.smtp?.configured(gymId));
      return scope(gymId, async tx => {
        const plan = catalogMissing((await tx.select().from(plans).where(eq(plans.id, planId)))[0], 'Plan not found');
        checkPrice(plan, query.amountCents);
        // An erased member's memberships are cancelled; the join only keeps the listing to members the notice can name.
        const where = and(eq(memberships.planId, plan.id), live, isNull(members.anonymizedAt));
        const member = and(eq(members.gymId, memberships.gymId), eq(members.id, memberships.memberId));
        const [counted] = await tx.select({ total: count() }).from(memberships).innerJoin(members, member).where(where);
        const total = counted?.total ?? 0;
        const rows = await tx.select({ membership: memberships, firstName: members.firstName, lastName: members.lastName })
          .from(memberships).innerJoin(members, member).where(where)
          .orderBy(asc(members.lastName), asc(members.firstName), asc(memberships.id)).limit(c.planPriceChangeLimit);
        const reach = await householdReach(tx, gymId, [...new Set(rows.map(row => row.membership.householdId))]);
        const items = rows.map(({ membership: row, firstName, lastName }): c.PlanPriceChangeMembership => {
          const skipReason = blocked(row, plan);
          const inCommitment = row.commitmentEndsOn !== null && row.commitmentEndsOn > query.effectiveOn;
          const customPrice = row.amountCents !== plan.amountCents || row.interval !== plan.interval;
          const includedByAll = !skipReason && !inCommitment && !customPrice;
          return { id: row.id, revision: row.revision, householdId: row.householdId, memberName: `${firstName} ${lastName}`.trim(),
            status: c.membershipStatusSchema.parse(row.status), amountCents: row.amountCents, currency: row.currency,
            interval: c.billingIntervalSchema.parse(row.interval), commitmentEndsOn: row.commitmentEndsOn, inCommitment, customPrice,
            scheduled: row.scheduledPlanId === null ? null : { planId: row.scheduledPlanId, amountCents: row.scheduledAmountCents!,
              interval: c.billingIntervalSchema.parse(row.scheduledInterval), on: row.scheduledOn! },
            tickedByDefault: includedByAll && row.status !== 'frozen', includedByAll, skipReason,
            householdReach: reach.get(row.householdId) ?? 'no_address' };
        });
        const movable = [...new Set(items.filter(item => !item.skipReason).map(item => item.householdId))];
        const switchesToPlan = await tx.$count(memberships, and(eq(memberships.scheduledPlanId, plan.id), ne(memberships.planId, plan.id), live));
        return c.planPriceChangePreviewSchema.parse({
          plan: { id: plan.id, name: plan.name, amountCents: plan.amountCents, currency: plan.currency, interval: plan.interval,
            active: plan.active, revision: plan.revision },
          amountCents: query.amountCents, effectiveOn: query.effectiveOn, today,
          change: query.amountCents > plan.amountCents ? 'increase' : query.amountCents < plan.amountCents ? 'decrease' : 'none',
          memberships: items, total, households: movable.length,
          householdsWithoutAddress: movable.filter(id => reach.get(id) === 'no_address').length,
          householdsPayerErased: movable.filter(id => reach.get(id) === 'payer_erased').length,
          householdsSuppressed: movable.filter(id => reach.get(id) === 'suppressed').length,
          switchesToPlan, canEmail });
      });
    },
    /**
     * Checks the listed memberships are this gym's (404 before any write), then under the plan lock looks for the request
     * key: the same request resumes (or replays its recorded result), other parameters are `request_reused`; a new one
     * checks the price and date and changes the plan's price (revision-checked) with its audit. The memberships are then
     * scheduled household by household; one that left the plan, was cancelled or changed since the preview is skipped
     * (`changed`), as are those that can't take the change.
     */
    async apply(context: MutationContext, planId: string, input: unknown): Promise<c.PlanPriceChangeResult> {
      const parsed = c.applyPlanPriceChangeRequestSchema.safeParse(input);
      if (!parsed.success || !c.idSchema.safeParse(planId).success) return invalid('Invalid price change request');
      const request = parsed.data, gym = await settings.get(context.gymId);
      const ids = request.memberships.map(item => item.id).sort();
      const revisions = new Map(request.memberships.map(item => [item.id, item.revision]));
      const recorded: RecordedPriceChange = { requestKey: request.requestKey, planId, amountCents: request.amountCents,
        effectiveOn: request.effectiveOn, notify: request.notify, memberships: commandDigest(ids), count: ids.length };
      const start = await scope(context.gymId, async tx => {
        await lockPriceRequest(tx, context.gymId, request.requestKey);
        const plan = await lockPlan(tx, planId);
        const listed = await tx.select({ id: memberships.id, householdId: memberships.householdId }).from(memberships)
          .where(inArray(memberships.id, ids));
        if (listed.length !== ids.length) throw new AppError('not_found', 'Membership not found');
        if (request.notify && !jobs) throw new AppError('unavailable', 'Price change notices are not configured');
        const prior = await recordedRequest(tx, request.requestKey);
        if (prior) {
          if (!sameRequest(prior, recorded)) refuse('request_reused', 'Request key reused with different parameters');
          const result = await recordedResult(tx, planId, request.requestKey);
          if (!result) checkDate(request.effectiveOn, localDate(clock.now(), gym.timezone));
          return result ? { result } : { listed };
        }
        checkPrice(plan, request.amountCents);
        checkDate(request.effectiveOn, localDate(clock.now(), gym.timezone));
        const guard = revisionGuard(plans.revision, request.planRevision);
        const after = assertRevised(await tx.update(plans).set({ amountCents: request.amountCents, revision: guard.next })
          .where(and(eq(plans.id, planId), guard.matches)).returning());
        await catalogAudit(tx, context, clock, planPriceChangedAction, 'plan', planId,
          { amountCents: plan.amountCents, revision: plan.revision }, { request: recorded, amountCents: after.amountCents, revision: after.revision });
        return { listed };
      });
      if ('result' in start) return start.result!;
      // Households in ID order, a few per transaction, each with every listed membership of its own.
      const byHousehold = new Map<string, string[]>();
      for (const row of start.listed) byHousehold.set(row.householdId, [...byHousehold.get(row.householdId) ?? [], row.id]);
      const chunks: Chunk[] = [];
      for (const householdId of [...byHousehold.keys()].sort()) {
        const own = byHousehold.get(householdId)!, last = chunks.at(-1);
        if (last && last.householdIds.length < chunkHouseholds && last.membershipIds.length + own.length <= chunkMemberships) {
          last.householdIds.push(householdId); last.membershipIds.push(...own);
        } else chunks.push({ householdIds: [householdId], membershipIds: [...own] });
      }
      const outcomes: Outcome[] = [];
      for (const chunk of chunks) outcomes.push(await withJobTransaction(scope, context.gymId,
        transaction => schedule(transaction, context, request, planId, gym.timezone, chunk, revisions)));
      const reach = outcomes.flatMap(outcome => outcome.reach);
      const result = c.planPriceChangeResultSchema.parse({ planId, amountCents: request.amountCents, effectiveOn: request.effectiveOn,
        scheduled: outcomes.flatMap(outcome => outcome.scheduled).sort(),
        skipped: outcomes.flatMap(outcome => outcome.skipped).sort((a, b) => a.id.localeCompare(b.id)),
        householdsNotified: outcomes.reduce((sum, outcome) => sum + outcome.notified, 0),
        householdsWithoutAddress: reach.filter(value => value === 'no_address').length,
        householdsPayerErased: reach.filter(value => value === 'payer_erased').length,
        householdsSuppressed: reach.filter(value => value === 'suppressed').length });
      // The first run to finish records the result; a concurrent or later one with the key returns it.
      return scope(context.gymId, async tx => {
        await lockPlan(tx, planId);
        const done = await recordedResult(tx, planId, request.requestKey);
        if (done) return done;
        await catalogAudit(tx, context, clock, planPriceChangeAppliedAction, 'plan', planId, undefined,
          { requestKey: request.requestKey, result });
        return result;
      });
    },
  };
}
export type PriceChangeService = ReturnType<typeof createPriceChangeService>;
let configured: PriceChangeService | undefined;
export function configurePriceChanges(service: PriceChangeService) { configured = service; }
let fallback: PriceChangeService | undefined;
/** The runtime's service; unconfigured, one with no jobs or SMTP (no notices; the preview says it can't email). */
export function priceChanges(): PriceChangeService {
  return configured ?? (fallback ??= createPriceChangeService({}));
}
