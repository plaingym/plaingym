// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { forGym, forSystem, gyms, writeAudit, revisionGuard, assertRevised, RevisionConflictError } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { deleteDemoIdentities } from '../../infra/auth/demo-cleanup.js';
import { sandboxSettings } from '../../demo/config.js';

export function createGymDeleteService(options: {
  clock: Clock; removeUploads(gymId: string): Promise<void>; scope?: typeof forGym; system?: typeof forSystem;
}) {
  const scope = options.scope ?? forGym, system = options.system ?? forSystem;
  return { async remove(gymId: string, revision: number, actorUserId?: string): Promise<void> {
    assertNoTransaction('gym.delete');
    // Suspension closes tenant resolution before any external storage work. A failed
    // cleanup leaves a suspended, retryable gym; never an active gym missing files.
    const suspendedRevision = await scope(gymId, async (tx) => {
      const [gym] = await tx.select().from(gyms).where(eq(gyms.id, gymId)).for('update');
      if (!gym) throw new AppError('not_found', 'Gym not found');
      if (gym.revision !== revision) throw new RevisionConflictError();
      const guard = revisionGuard(gyms.revision, revision);
      const updated = assertRevised(await tx.update(gyms).set({ status: 'suspended', revision: guard.next, updatedAt: options.clock.now() })
        .where(and(eq(gyms.id, gymId), guard.matches)).returning({ revision: gyms.revision }));
      await writeAudit(tx, { gymId, actorKind: actorUserId ? 'user' : 'system', ...(actorUserId ? { actorUserId } : {}),
        action: 'gym.deletion_started', targetType: 'gym', targetId: gymId, occurredAt: options.clock.now() });
      return { revision: updated.revision, sandbox: sandboxSettings(gym.settings) !== null ||
        /^demo-reservation\.[0-9a-f-]{36}@example[.]invalid$/.test(String((gym.settings as { bootstrapOwnerEmail?: string }).bootstrapOwnerEmail ?? '')) };
    });
    await options.removeUploads(gymId);
    await system(async (tx) => {
      const removed = await tx.delete(gyms).where(and(eq(gyms.id, gymId), eq(gyms.revision, suspendedRevision.revision), eq(gyms.status, 'suspended'))).returning({ id: gyms.id });
      if (removed.length !== 1) throw new RevisionConflictError();
      if (suspendedRevision.sandbox) await deleteDemoIdentities(tx, gymId);
    });
  } };
}
export type GymDeleteService = ReturnType<typeof createGymDeleteService>;
