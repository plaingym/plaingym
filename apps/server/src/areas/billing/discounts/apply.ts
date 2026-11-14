// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, ilike, inArray, isNull } from 'drizzle-orm';
import { discounts, discountPlans, membershipDiscounts, uuidv7, assertRevised, revisionGuard, type Transaction } from '@plaingym/db';
import { AppError, createTranslator, type Clock } from '@plaingym/shared';
import { appliedMembershipDiscountSchema, membershipDiscountSelectionSchema,
  type AppliedMembershipDiscount, type MembershipDiscountSelection } from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import type { MutationContext } from '../../../core/interfaces/common.js';
import type { MembershipDiscount } from '../invoicing/index.js';
import { catalogAudit } from '../catalog.js';
import messages from '../../../../../../locales/en/billing/discounts.json' with { type: 'json' };

const t = createTranslator({ 'billing/discounts': messages });
type Audience = 'staff' | 'public';
type Reason = 'discount_unknown' | 'discount_ended' | 'discount_used_up' | 'discount_plan';
type Application = typeof membershipDiscounts.$inferSelect;
export interface ResolvedDiscount {
  readonly row: typeof discounts.$inferSelect;
  readonly planIds: string[];
  readonly audience: Audience;
}
function refuse(reason: Reason, audience: Audience): never {
  if (audience === 'public') throw new AppError('invalid_request', t('billing/discounts:discount_unknown'), { reason: ['discount_unknown'] });
  throw new AppError(reason === 'discount_unknown' ? 'not_found' : 'conflict', t('billing/discounts:' + reason), { reason: [reason] });
}

/** Caller holds household and membership locks first. All checks and writes use its transaction. */
export async function resolveDiscount(tx: Transaction, selection: MembershipDiscountSelection, options: {
  planIds: readonly string[]; timezone: string; clock: Clock; audience?: Audience; useTaken?: boolean;
}): Promise<ResolvedDiscount> {
  const selected = membershipDiscountSelectionSchema.parse(selection), audience = options.audience ?? 'staff';
  // Codes have no SQL wildcard characters; ilike matches the complete code, in any case.
  const [row] = await tx.select().from(discounts).where('discountId' in selected
    ? eq(discounts.id, selected.discountId) : ilike(discounts.code, selected.code)).for('update');
  if (!row || !row.active) refuse('discount_unknown', audience);
  if (row.endsOn !== null && localDate(options.clock.now(), options.timezone) > row.endsOn) refuse('discount_ended', audience);
  if (!options.useTaken && row.maxUses !== null && row.uses >= row.maxUses) refuse('discount_used_up', audience);
  const planIds = (await tx.select({ id: discountPlans.planId }).from(discountPlans)
    .where(eq(discountPlans.discountId, row.id)).orderBy(asc(discountPlans.planId))).map(plan => plan.id);
  if (planIds.length && options.planIds.some(id => !planIds.includes(id.toLowerCase()))) refuse('discount_plan', audience);
  return { row, planIds, audience };
}

/** Reserve a whole operation's uses together; never return uses on cancellation or removal (only a voided join returns them). */
export async function takeDiscountUses(tx: Transaction, context: MutationContext, clock: Clock, resolved: ResolvedDiscount, count = 1) {
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('Invalid discount use count');
  // Re-read under the lock: a caller can reserve more than once within its transaction.
  const [before] = await tx.select().from(discounts).where(eq(discounts.id, resolved.row.id)).for('update');
  if (!before) refuse('discount_unknown', resolved.audience);
  const uses = before.uses + count;
  if (uses > (before.maxUses ?? 2_147_483_647)) refuse('discount_used_up', resolved.audience);
  const guard = revisionGuard(discounts.revision, before.revision);
  assertRevised(await tx.update(discounts).set({ uses, revision: guard.next })
    .where(and(eq(discounts.id, before.id), guard.matches)).returning({ id: discounts.id }));
  await catalogAudit(tx, context, clock, 'billing.discount.uses_taken', 'discount', before.id,
    { uses: before.uses, revision: before.revision }, { uses, revision: before.revision + 1 });
}

export async function applyDiscount(tx: Transaction, context: MutationContext, clock: Clock, resolved: ResolvedDiscount,
  membership: { id: string; householdId: string }, useTaken = false): Promise<Application> {
  if (!useTaken) await takeDiscountUses(tx, context, clock, resolved);
  const { row, planIds } = resolved, now = clock.now();
  const [applied] = await tx.insert(membershipDiscounts).values({ id: uuidv7(), gymId: context.gymId,
    householdId: membership.householdId, membershipId: membership.id, discountId: row.id,
    name: row.name, percentBasisPoints: row.percentBasisPoints, amountCents: row.amountCents, currency: row.currency,
    waivesSignupFee: row.waivesSignupFee, duration: row.duration,
    cyclesLeft: row.duration === 'once' ? 1 : row.duration === 'cycles' ? row.cycles : null,
    planIds, appliedAt: now, createdAt: now,
    ...(row.duration === null ? { endedAt: now, endReason: 'completed' } : {}),
  }).returning();
  await catalogAudit(tx, context, clock, 'billing.membership.discount_applied', 'membership', membership.id, undefined, applied);
  return applied!;
}

/** Only live applications are exposed; ended history remains in the database. */
export async function liveDiscounts(tx: Transaction, membershipIds: readonly string[]) {
  const rows = membershipIds.length ? await tx.select().from(membershipDiscounts)
    .where(and(inArray(membershipDiscounts.membershipId, [...membershipIds]), isNull(membershipDiscounts.endedAt))) : [];
  return new Map(rows.map(row => [row.membershipId, row]));
}
export function presentDiscount(row: Application | undefined): AppliedMembershipDiscount | null {
  if (!row) return null;
  const { id, discountId, name, percentBasisPoints, amountCents, currency, waivesSignupFee, duration, cyclesLeft, planIds } = row;
  return appliedMembershipDiscountSchema.parse({ id, discountId, name, percentBasisPoints, amountCents, currency,
    waivesSignupFee, duration, cyclesLeft, planIds });
}
export function priceDiscount(row: AppliedMembershipDiscount | Application | null | undefined): MembershipDiscount | undefined {
  if (row?.percentBasisPoints != null) return { name: row.name, kind: 'percentage', basisPoints: row.percentBasisPoints };
  if (row?.amountCents != null) return { name: row.name, kind: 'fixed', amountCents: row.amountCents };
  return undefined;
}

/** Eligibility is locked in with the application, never read from the catalog during a switch. */
export function switchDiscount(row: AppliedMembershipDiscount | Application | null | undefined, planId: string): 'kept' | 'ended' | 'none' {
  if (!row) return 'none';
  return !row.planIds.length || row.planIds.includes(planId.toLowerCase()) ? 'kept' : 'ended';
}

/** Caller holds the household and membership locks. Never gives back a catalog use: `released` marks a voided join's
 * application, whose uses the join cleanup returns with {@link releaseDiscountUses}. */
export async function endDiscount(tx: Transaction, context: MutationContext, clock: Clock, membershipId: string,
  reason: 'replaced' | 'removed' | 'switch' | 'released') {
  const [before] = await tx.select().from(membershipDiscounts).where(and(eq(membershipDiscounts.membershipId, membershipId),
    isNull(membershipDiscounts.endedAt))).for('update');
  if (!before) return;
  const guard = revisionGuard(membershipDiscounts.revision, before.revision);
  const after = assertRevised(await tx.update(membershipDiscounts).set({ endedAt: clock.now(), endReason: reason, revision: guard.next })
    .where(and(eq(membershipDiscounts.id, before.id), guard.matches)).returning());
  await catalogAudit(tx, context, clock, 'billing.membership.discount_ended', 'membership', membershipId, before, after);
}

/**
 * Gives back uses an unpaid join took, the one case a use returns. Caller holds the household lock and writes, in the same
 * transaction, the record that makes a replay release nothing. Takes the discount row lock, as reserving does.
 */
export async function releaseDiscountUses(tx: Transaction, context: MutationContext, clock: Clock, discountId: string, count: number) {
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('Invalid discount use count');
  const [before] = await tx.select().from(discounts).where(eq(discounts.id, discountId)).for('update');
  if (!before) return 0;
  // Never below zero, whatever happened to the counter since the uses were taken.
  const uses = Math.max(0, before.uses - count), guard = revisionGuard(discounts.revision, before.revision);
  if (uses === before.uses) return 0;
  assertRevised(await tx.update(discounts).set({ uses, revision: guard.next })
    .where(and(eq(discounts.id, before.id), guard.matches)).returning({ id: discounts.id }));
  await catalogAudit(tx, context, clock, 'billing.discount.uses_released', 'discount', before.id,
    { uses: before.uses, revision: before.revision }, { uses, revision: before.revision + 1 });
  return before.uses - uses;
}

export async function switchAppliedDiscount(tx: Transaction, context: MutationContext, clock: Clock, membershipId: string, planId: string) {
  const current = (await liveDiscounts(tx, [membershipId])).get(membershipId);
  if (switchDiscount(current, planId) === 'ended') await endDiscount(tx, context, clock, membershipId, 'switch');
}

/** Called only for a billed full cycle, in the transaction advancing the membership's due date. */
export async function takeDiscountCycle(tx: Transaction, context: MutationContext, clock: Clock, membershipId: string) {
  const [before] = await tx.select().from(membershipDiscounts).where(and(eq(membershipDiscounts.membershipId, membershipId),
    isNull(membershipDiscounts.endedAt))).for('update');
  if (!before || before.cyclesLeft === null) return;
  const cyclesLeft = Math.max(0, before.cyclesLeft - 1), guard = revisionGuard(membershipDiscounts.revision, before.revision);
  const after = assertRevised(await tx.update(membershipDiscounts).set({ cyclesLeft, revision: guard.next,
    ...(cyclesLeft === 0 ? { endedAt: clock.now(), endReason: 'completed' } : {}) })
    .where(and(eq(membershipDiscounts.id, before.id), guard.matches)).returning());
  await catalogAudit(tx, context, clock, 'billing.membership.discount_cycle_taken', 'membership', membershipId, before, after);
}
