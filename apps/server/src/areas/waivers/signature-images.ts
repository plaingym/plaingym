// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq } from 'drizzle-orm';
import { auditEvents, forGym, members, waiverSignatures, writeAudit, type Transaction } from '@plaingym/db';
import { notFound } from '../../core/interfaces/common.js';
import { logError } from '../../core/log.js';
import type { Uploads } from '../../infra/storage/index.js';

export const SIGNATURE_IMAGE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const claimed = 'waiver.signature_image.claimed', deleted = 'waiver.signature_image.deleted';
const targetType = 'waiver_signature_image';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const path = new RegExp(`^(${uuid})/waivers/(${uuid})/signatures/(${uuid})\\.png$`);

function imageId(gymId: string, memberId: string, key: string) {
  const match = path.exec(key);
  if (!match || match[1] !== gymId || match[2] !== memberId) notFound();
  return match[3]!;
}
async function marker(tx: Transaction, id: string, action: string) {
  const [row] = await tx.select({ occurredAt: auditEvents.occurredAt }).from(auditEvents)
    .where(and(eq(auditEvents.targetType, targetType), eq(auditEvents.targetId, id), eq(auditEvents.action, action)))
    .orderBy(desc(auditEvents.occurredAt)).limit(1);
  return row;
}
async function record(tx: Transaction, gymId: string, id: string, action: string, now: Date) {
  await writeAudit(tx, { gymId, actorKind: 'system', action, targetType, targetId: id, before: null, after: null, occurredAt: now });
}
/** Caller holds the member row lock. Deletion decisions survive storage failures and process restarts. */
export async function checkSignatureImage(tx: Transaction, gymId: string, memberId: string, key: string, claimAt?: Date) {
  const id = imageId(gymId, memberId, key);
  if (await marker(tx, id, deleted)) notFound();
  if (claimAt) await record(tx, gymId, id, claimed, claimAt);
}

/** Mark only unsigned images; physical removal remains the backup-aware storage sweep's responsibility. */
export async function sweepSignatureImages(options: {
  gymId: string; uploads: Uploads; now: Date; scope?: typeof forGym;
}): Promise<number> {
  const { gymId, uploads, now } = options, scope = options.scope ?? forGym;
  const before = new Date(now.getTime() - SIGNATURE_IMAGE_GRACE_MS);
  const candidates = (await uploads.list(`${gymId}/waivers/`)).flatMap(info => {
    const match = path.exec(info.key);
    return !match || match[1] !== gymId || info.deletedAt || info.createdAt >= before ? [] : [{ key: info.key, memberId: match[2]!, id: match[3]! }];
  });
  if (!candidates.length) return 0;
  // Signatures are never re-pointed, so a key referenced now stays safe to skip. Unreferenced keys are checked again under the lock.
  const signed = new Set((await scope(gymId, tx => tx.select({ key: waiverSignatures.signatureImageKey }).from(waiverSignatures))).map(row => row.key));
  let marked = 0, failure: unknown;
  for (const { key, memberId, id } of candidates) {
    if (signed.has(key)) continue;
    const remove = await scope(gymId, async tx => {
      // Signing, cleanup and erasure share this lock. Never hold it across storage I/O.
      const [person] = await tx.select({ id: members.id }).from(members).where(eq(members.id, memberId)).for('update');
      // A removed member has no signatures (foreign key) and can never sign again, so its images are unreferenced.
      if (person) {
        const [reference] = await tx.select({ id: waiverSignatures.id }).from(waiverSignatures)
          .where(and(eq(waiverSignatures.memberId, memberId), eq(waiverSignatures.signatureImageKey, key))).limit(1);
        if (reference) return false;
      }
      if (await marker(tx, id, deleted)) return true;
      const claim = await marker(tx, id, claimed);
      if (claim && claim.occurredAt >= before) return false;
      await record(tx, gymId, id, deleted, now);
      return true;
    });
    if (!remove) continue;
    // The recorded decision makes a failed marker retry on the next run; keep going for the other images.
    try { await uploads.markDeleted(key); marked++; }
    catch (error) { failure ??= error; logError('waivers.signature_image.mark_failed', { gymId }, error); }
  }
  if (failure) throw failure;
  return marked;
}
