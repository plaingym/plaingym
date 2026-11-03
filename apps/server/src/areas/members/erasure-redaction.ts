// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { auditEvents, forGym, households, writeAudit } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { Jobs } from '../../infra/jobs/index.js';

/** Queues the provider redaction of the customer an erased household had. */
export const redactCustomerJob = 'members.erasure.redact_customer';
/** Daily check that every erased household's provider customer has a redaction queued (see `queueEarlierRedactions`). */
export const redactEarlierJob = 'members.erasure.redact_earlier';
/** Audited (target: the erased household) when the check above queued that household's customer; the marker keeps a rerun from queuing it again. */
export const redactionQueuedAction = 'members.erasure.redaction_queued';
/** One run queues at most this many customers; the next daily run continues. */
export const redactEarlierBatch = 200;
const customerPattern = /^cus_[A-Za-z0-9_]+$/;

/**
 * One-time redaction of provider customers erased before the redaction covered every personal field (or before it
 * existed): reads the gym's own `household.anonymized` audits, whose `before.stripeCustomerId` kept the cleared ID, and
 * queues one redaction job per customer under a stable key (`redact-earlier:<customer>`). Each queued customer gets a
 * `members.erasure.redaction_queued` audit, so a rerun queues nothing new even after the job queue has pruned its
 * finished rows. The redaction itself is idempotent, so a crash between the job and its marker only repeats it.
 * A customer that a household of the gym links today is skipped (and not marked): the gym has since reused it, and
 * redacting it would erase a live customer. Returns the number of customers queued, at most `redactEarlierBatch`.
 */
export async function queueEarlierRedactions(options: { gymId: string; timezone: string; jobs: Pick<Jobs, 'enqueue'>; clock: Clock; scope?: typeof forGym; batch?: number }): Promise<number> {
  const { gymId, timezone, jobs, clock, scope = forGym, batch = redactEarlierBatch } = options;
  // Only erasures that recorded a customer ID are read (an erasure without one stores no `before`), and the markers carry nothing else.
  const rows = await scope(gymId, tx => tx.select({ action: auditEvents.action, targetId: auditEvents.targetId, before: auditEvents.before, after: auditEvents.after })
    .from(auditEvents).where(or(and(eq(auditEvents.action, 'household.anonymized'), isNotNull(auditEvents.before)), eq(auditEvents.action, redactionQueuedAction))));
  const customerOf = (value: unknown): string | undefined => {
    const id = (value as { stripeCustomerId?: unknown } | null)?.stripeCustomerId;
    return typeof id === 'string' && customerPattern.test(id) ? id : undefined;
  };
  const seen = new Set(rows.filter(row => row.action === redactionQueuedAction).map(row => customerOf(row.after)));
  const pending = new Map<string, string>();
  for (const row of rows) {
    const customerId = row.action === 'household.anonymized' ? customerOf(row.before) : undefined;
    if (customerId && !seen.has(customerId) && !pending.has(customerId)) pending.set(customerId, row.targetId);
  }
  if (!pending.size) return 0;
  const linked = new Set((await scope(gymId, tx => tx.select({ id: households.stripeCustomerId }).from(households)
    .where(inArray(households.stripeCustomerId, [...pending.keys()])))).map(row => row.id));
  let queued = 0;
  for (const [customerId, targetId] of pending) {
    if (linked.has(customerId)) continue;
    if (queued >= batch) break;
    // The job first, then the marker: no network or queue call runs inside the audit's transaction.
    await jobs.enqueue(redactCustomerJob, { customerId }, { gymId, timezone, idempotencyKey: `redact-earlier:${customerId}`, maxAttempts: 12 });
    await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: redactionQueuedAction, targetType: 'household',
      targetId, after: { stripeCustomerId: customerId }, occurredAt: clock.now() }));
    queued++;
  }
  return queued;
}
