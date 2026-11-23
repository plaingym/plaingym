// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, gt, inArray, ne } from 'drizzle-orm';
import { auditEvents, gyms, writeAudit, type Transaction } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import type { MutationContext } from '../../core/interfaces/common.js';

/** Reads only the current restore's latest check, including an explicitly requested rerun. */
export async function readRestoreCheck(tx: Transaction) {
  const [restore] = await tx.select({ id: auditEvents.id }).from(auditEvents)
    .where(eq(auditEvents.action, 'restore.completed'))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1);
  const latest = async (action: string, targetId: string, afterId?: string) => (await tx.select().from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId), afterId
      ? gt(auditEvents.createdAt, tx.select({ at: auditEvents.createdAt }).from(auditEvents).where(eq(auditEvents.id, afterId))) : undefined))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1))[0];
  const request = restore ? await latest('billing.runner.restore_requested', restore.id) : undefined;
  const rerun = restore ? await latest('settings.go_live.reconciliation_requested', restore.id) : undefined;
  const started = restore ? await latest('billing.runner.restore_check_started', restore.id, rerun?.id) : undefined;
  const checked = started ? await latest('billing.runner.restore_checked', started.id) : undefined;
  const report = checked?.after as { inspected: number; unresolved: number; stripeConfigured?: boolean; stripeMode?: 'test' | 'live' | null } | undefined;
  return { restore, request, checked, report };
}

/** Both Stripe save paths audit the mode in the transaction that saves the encrypted credentials. */
export async function readSavedStripeMode(tx: Transaction) {
  const [saved] = await tx.select({ after: auditEvents.after }).from(auditEvents)
    .where(inArray(auditEvents.action, ['integrations.stripe_saved', 'setup.stripe_configured']))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1);
  const mode = (saved?.after as { mode?: unknown } | undefined)?.mode;
  return mode === 'test' || mode === 'live' ? mode : undefined;
}

export function restoreCheckCoversStripe(report: Awaited<ReturnType<typeof readRestoreCheck>>['report'], stripe: boolean, mode?: 'test' | 'live') {
  return !stripe || !!mode && report?.stripeConfigured === true && report.stripeMode === mode;
}

/**
 * Whether a busy restore check's follow-up for `restoreId` (the latest restore when absent) should start, and the restore
 * it checks. It skips when billing is on, the restore isn't the latest, or the latest check is already clear for the
 * saved Stripe mode (go-live's rule), with Stripe counted when it resolved or its settings are stored.
 */
async function restoreCheckStart(tx: Transaction, gymId: string, restoreId: string | undefined, stripeResolved: boolean, lock: boolean) {
  // Only the presence of a nonempty configuration matters to this decision.
  const read = tx.select({ billingEnabled: gyms.billingEnabled, hasStripeConfig: ne(gyms.stripeConfig, '') })
    .from(gyms).where(eq(gyms.id, gymId));
  const [gym] = await (lock ? read.for('update') : read);
  if (!gym) throw new AppError('not_found', 'Gym not found');
  const { restore, report } = await readRestoreCheck(tx);
  const clear = report?.unresolved === 0
    && restoreCheckCoversStripe(report, stripeResolved || gym.hasStripeConfig === true, await readSavedStripeMode(tx));
  const start = !gym.billingEnabled && !clear && (!restoreId || restore?.id === restoreId);
  return { start, restoreId: restoreId ?? restore?.id, stripeStored: gym.hasStripeConfig === true };
}

/**
 * Whether the gym has Stripe settings stored, read in the caller's transaction (under the gym row lock a Stripe save
 * takes, when the caller holds it). Only the presence of a nonempty configuration, never its value.
 */
export async function stripeConfigStored(tx: Transaction, gymId: string): Promise<boolean> {
  const [gym] = await tx.select({ stored: ne(gyms.stripeConfig, '') }).from(gyms).where(eq(gyms.id, gymId));
  return gym?.stored === true;
}

/**
 * The follow-up's early decision, with no lock, before it reads the Stripe credentials: a follow-up with nothing to do
 * ends here even when they can't be read. Stripe counts only when its settings are stored.
 */
export function readRestoreCheckStart(tx: Transaction, gymId: string, restoreId: string | undefined) {
  return restoreCheckStart(tx, gymId, restoreId, false, false);
}

/**
 * The follow-up's final decision: the same rule under the gym row lock that turning billing on takes, held until `tx`
 * ends. A check start the caller records in `tx` then commits before billing can turn on.
 */
export function holdRestoreCheckStart(tx: Transaction, gymId: string, restoreId: string | undefined, stripeResolved: boolean) {
  return restoreCheckStart(tx, gymId, restoreId, stripeResolved, true);
}

/** Called under the gym lock; the caller saves the returned billing pause with its Stripe settings in this transaction. */
export async function pauseRestoredBillingForStripe(tx: Transaction, context: MutationContext, billingEnabled: boolean, at: Date, mode: 'test' | 'live') {
  if (!billingEnabled) return false;
  const { restore, checked, report } = await readRestoreCheck(tx);
  if (!restore || restoreCheckCoversStripe(report, true, mode)) return false;
  await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
    ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
    action: 'settings.go_live.billing_paused_for_stripe', targetType: 'gym', targetId: context.gymId,
    before: { billingEnabled: true }, after: { billingEnabled: false, restoreId: restore.id, checkId: checked?.id ?? null,
      stripeMode: mode }, occurredAt: at });
  return true;
}
