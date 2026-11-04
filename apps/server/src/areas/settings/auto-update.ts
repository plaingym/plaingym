// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { forGym, gyms, RevisionConflictError, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { updateAutoUpdateSettingsRequestSchema, type UpdateAutoUpdateSettingsRequest } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';

/**
 * The owner's switch for automatic patch updates, kept in the gym's opaque settings as `automaticUpdates`. A gym
 * without the key has them on (the default). The switch carries its own revision, so saving it doesn't make the
 * other settings sections stale, and theirs don't make it stale.
 */
export interface AutoUpdateSetting { readonly enabled: boolean; readonly revision: number; readonly timezone: string }
function stored(settings: unknown): { enabled: boolean; revision: number } {
  const value = (settings as { automaticUpdates?: { enabled?: unknown; revision?: unknown } } | null)?.automaticUpdates;
  const revision = typeof value?.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : 1;
  return { enabled: value?.enabled !== false, revision };
}
async function readGym(tx: Transaction, gymId: string, lock: boolean) {
  const query = tx.select({ settings: gyms.settings, timezone: gyms.timezone }).from(gyms).where(eq(gyms.id, gymId));
  // The settings sections that rewrite `settings` (backups, setup) hold this row lock too, so no save is lost.
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new AppError('not_found', 'Gym not found');
  return row;
}
export function createAutoUpdateSettings(options: { scope?: typeof forGym; clock?: Clock } = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return {
    async get(gymId: string): Promise<AutoUpdateSetting> {
      const row = await scope(gymId, tx => readGym(tx, gymId, false));
      return { ...stored(row.settings), timezone: row.timezone };
    },
    /** A stale revision throws `RevisionConflictError` (409) and changes nothing. */
    async update(context: MutationContext, input: UpdateAutoUpdateSettingsRequest): Promise<AutoUpdateSetting> {
      const { enabled, revision } = updateAutoUpdateSettingsRequestSchema.parse(input);
      return scope(context.gymId, async (tx) => {
        const row = await readGym(tx, context.gymId, true), before = stored(row.settings);
        if (before.revision !== revision) throw new RevisionConflictError();
        const after = { enabled, revision: before.revision + 1 };
        await tx.update(gyms).set({ settings: { ...row.settings as object, automaticUpdates: after }, updatedAt: clock.now() })
          .where(eq(gyms.id, context.gymId));
        await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
          ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
          action: 'settings.automatic_updates.updated', targetType: 'gym', targetId: context.gymId,
          before: { enabled: before.enabled }, after: { enabled }, occurredAt: clock.now() });
        return { ...after, timezone: row.timezone };
      });
    },
  };
}
export type AutoUpdateSettings = ReturnType<typeof createAutoUpdateSettings>;
