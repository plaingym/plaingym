// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray } from 'drizzle-orm';
import { auditEvents, forGym, writeAudit, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { Uploads } from '../../infra/storage/index.js';

type Admission = typeof auditEvents.$inferSelect;
/** Shared durable claim, storage deletion and completion markers. Eligibility and row deletion stay with each intake. */
export function createAdmissionCleanup<State>(options: {
  scope: typeof forGym; clock: Clock; uploadsFor(gymId: string): Promise<Uploads>;
  prefix: 'public.join' | 'public.drop_in'; targetType: 'household' | 'member'; excluded: readonly string[];
  lock(tx: Transaction, targetId: string): Promise<State>;
  memberIds(admission: Admission): string[];
  ready?(admission: Admission): boolean;
  claim(tx: Transaction, gymId: string, targetId: string, state: State, admission: Admission): Promise<boolean>;
}) {
  const { scope, clock, prefix } = options;
  const admitted = `${prefix}.admitted`, started = `${prefix}.cleanup.started`, cleaned = `${prefix}.cleaned`, retained = `${prefix}.retained`;
  const audit = (tx: Transaction, gymId: string, targetId: string, action: string) => writeAudit(tx,
    { gymId, actorKind: 'system', action, targetType: options.targetType, targetId, occurredAt: clock.now() });
  /**
   * Resolve storage at the first candidate, once for an entire cleanup run unless a resolution fails:
   * a failure isn't kept, so the next candidate resolves storage again.
   */
  function uploadsForRun(gymId: string) {
    let uploads: Promise<Uploads> | undefined;
    return () => uploads ??= options.uploadsFor(gymId).catch((error: unknown) => { uploads = undefined; throw error; });
  }
  async function remove(gymId: string, targetId: string, uploads = uploadsForRun(gymId)) {
    const storage = await uploads();
    const ids = await scope(gymId, async tx => {
      // Acquire the same household/member locks as staff edits before reading append-only claim markers.
      const state = await options.lock(tx, targetId);
      const records = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, targetId),
        inArray(auditEvents.action, [admitted, started, ...options.excluded])));
      const admission = records.find(row => row.action === admitted);
      if (!admission || options.ready && !options.ready(admission) || records.some(row => options.excluded.includes(row.action))) return null;
      const memberIds = options.memberIds(admission);
      // A committed claim has already removed the eligible rows. Repeat only idempotent storage work.
      if (records.some(row => row.action === started)) return memberIds;
      if (!await options.claim(tx, gymId, targetId, state, admission)) {
        await audit(tx, gymId, targetId, retained);
        return null;
      }
      await audit(tx, gymId, targetId, started);
      return memberIds;
    });
    if (!ids) return false;
    // Never do storage I/O while holding the claim transaction's locks.
    for (const id of ids) for (const image of await storage.list(`${gymId}/waivers/${id}/signatures/`)) await storage.markDeleted(image.key);
    await scope(gymId, async tx => {
      await options.lock(tx, targetId);
      const done = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetId, targetId), eq(auditEvents.action, cleaned))).limit(1);
      if (!done.length) await audit(tx, gymId, targetId, cleaned);
    });
    return true;
  }
  return { remove, uploadsForRun };
}
