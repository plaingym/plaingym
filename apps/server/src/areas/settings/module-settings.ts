// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { forGym, gyms, revisionGuard, assertRevised, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { gymBrandingSchema, type GymBranding } from '@plaingym/shared/contracts';
import type { MutationContext } from '../../core/interfaces/common.js';
import { clock as defaultClock } from '../../core/clock.js';
import { gymProjection, presentGym } from './settings.js';

/** A feature module's stored settings, the gym's branding and the gym revision both are saved under. */
export interface ModuleSettings { readonly value: unknown; readonly branding: GymBranding; readonly revision: number }
/** What a module's save writes: its own value, and the gym's branding when the module edits it (logo, colors). */
export interface ModuleSettingsChange { readonly value: unknown; readonly branding?: GymBranding }

// A newer release may store more branding keys. A save writes back what it read, so this keeps them.
const storedBrandingSchema = z.looseObject(gymBrandingSchema.shape);
const modulesOf = (settings: unknown): Record<string, unknown> => {
  const modules = settings && typeof settings === 'object' ? (settings as { modules?: unknown }).modules : undefined;
  return modules && typeof modules === 'object' && !Array.isArray(modules) ? modules as Record<string, unknown> : {};
};
const read = (row: { settings: unknown; branding: unknown; revision: number }, moduleId: string): ModuleSettings => ({
  value: modulesOf(row.settings)[moduleId] ?? null,
  // Stored branding was validated on save; anything else reads as none rather than failing a public page.
  branding: storedBrandingSchema.catch({}).parse(row.branding), revision: row.revision,
});

/** A module's settings, read inside a caller's gym scope so other reads share its transaction. */
export async function readModuleSettings(tx: Transaction, gymId: string, moduleId: string): Promise<ModuleSettings> {
  const [row] = await tx.select({ settings: gyms.settings, branding: gyms.branding, revision: gyms.revision }).from(gyms).where(eq(gyms.id, gymId));
  if (!row) throw new AppError('not_found', 'Gym not found');
  return read(row, moduleId);
}

/** The gym's settings and a module's settings from one read of the gym row, for a page that shows both. */
export async function readGymAndModuleSettings(tx: Transaction, gymId: string, moduleId: string) {
  const [row] = await tx.select({ ...gymProjection, settings: gyms.settings }).from(gyms).where(eq(gyms.id, gymId));
  if (!row) throw new AppError('not_found', 'Gym not found');
  const { settings, ...gymRow } = row;
  return { gym: presentGym(gymRow), module: read({ settings, branding: row.branding, revision: row.revision }, moduleId) };
}

/**
 * Per-gym settings of a feature module, kept in the gym's opaque settings under `modules.<moduleId>`. A save takes the
 * gym revision, like every gym settings save, so it can't overwrite a change it hasn't seen; it may also change the
 * gym's branding in the same revision. Each save writes a `settings.module.updated` audit event naming the module.
 * Modules validate their own value: this store keeps whatever the module gives it.
 */
export function createModuleSettings(options: { scope?: typeof forGym; clock?: Clock } = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return {
    get: (gymId: string, moduleId: string) => scope(gymId, tx => readModuleSettings(tx, gymId, moduleId)),
    /** `change` gets the stored value and branding under the gym row's lock and returns what to save. */
    async save(context: MutationContext, moduleId: string, revision: number, change: (current: ModuleSettings) => ModuleSettingsChange): Promise<ModuleSettings> {
      return scope(context.gymId, async (tx) => {
        const [row] = await tx.select({ settings: gyms.settings, branding: gyms.branding, revision: gyms.revision })
          .from(gyms).where(eq(gyms.id, context.gymId)).for('update');
        if (!row) throw new AppError('not_found', 'Gym not found');
        const before = read(row, moduleId), next = change(before);
        const branding = next.branding === undefined ? before.branding : storedBrandingSchema.parse(next.branding);
        const settings = { ...(row.settings && typeof row.settings === 'object' ? row.settings : {}),
          modules: { ...modulesOf(row.settings), [moduleId]: next.value } };
        const guard = revisionGuard(gyms.revision, revision), now = clock.now();
        // A save that leaves branding alone doesn't write it: stored branding that reads as none stays as it was.
        const saved = assertRevised(await tx.update(gyms).set({ settings, ...(next.branding === undefined ? {} : { branding }), revision: guard.next, updatedAt: now })
          .where(and(eq(gyms.id, context.gymId), guard.matches)).returning({ revision: gyms.revision }));
        await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
          ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
          action: 'settings.module.updated', targetType: 'gym', targetId: context.gymId,
          before: { module: moduleId, value: before.value, branding: before.branding },
          after: { module: moduleId, value: next.value, branding }, occurredAt: now });
        return { value: next.value, branding, revision: saved.revision };
      });
    },
  };
}
export type ModuleSettingsStore = ReturnType<typeof createModuleSettings>;
