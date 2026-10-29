// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { auditEvents, forGym, gyms, writeAudit } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import type { MutationContext } from '../core/interfaces/common.js';

export const demoSignatureLimit = 64;
export const demoSignatureReservation = 'demo.waiver.signature_image.reserved';

/** Reserve before storage: failed/abandoned uploads retain their admission until sandbox deletion.
 * The gym row serializes all members and app processes without holding a transaction over storage. */
export async function reserveDemoSignature(scope: typeof forGym, context: MutationContext, memberId: string, now: Date) {
  await scope(context.gymId, async tx => {
    const [gym] = await tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, context.gymId)).for('no key update');
    if (!gym) throw new AppError('not_found', 'Gym not found');
    if (await tx.$count(auditEvents, eq(auditEvents.action, demoSignatureReservation)) >= demoSignatureLimit)
      throw new AppError('rate_limited', 'The demo signature upload limit has been reached');
    await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
      ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
      action: demoSignatureReservation, targetType: 'member', targetId: memberId,
      before: null, after: null, occurredAt: now });
  });
}
