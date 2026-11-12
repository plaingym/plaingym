// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, gt } from 'drizzle-orm';
import { auditEvents, writeAudit, type Transaction } from '@plaingym/db';
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
  const report = checked?.after as { inspected: number; unresolved: number; stripeConfigured?: boolean } | undefined;
  return { restore, request, checked, report };
}

/** Called under the gym lock; the caller saves the returned billing pause with its Stripe settings in this transaction. */
export async function pauseRestoredBillingForStripe(tx: Transaction, context: MutationContext, billingEnabled: boolean, at: Date) {
  if (!billingEnabled) return false;
  const { restore, checked, report } = await readRestoreCheck(tx);
  if (report?.stripeConfigured !== false) return false;
  await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
    ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
    action: 'settings.go_live.billing_paused_for_stripe', targetType: 'gym', targetId: context.gymId,
    before: { billingEnabled: true }, after: { billingEnabled: false, restoreId: restore!.id, checkId: checked!.id }, occurredAt: at });
  return true;
}
