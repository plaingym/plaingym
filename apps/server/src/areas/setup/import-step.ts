// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { forGym, gyms, auditEvents, writeAudit, revisionGuard, assertRevised, type Transaction } from '@plaingym/db';
import { AppError, createTranslator, type Clock } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import type { ImportJob, SetupFinishRequest } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';

const t = createTranslator(locales.en ?? {});
/** Reads an import run's progress for one gym (the import pipeline's `get`). */
export interface ImportRuns { get(gymId: string, id: string): Promise<ImportJob> }
/** The setup service's finish step; a fresh finish turns billing and member emails off. */
export interface SetupFinisher {
  finish(context: MutationContext, input: SetupFinishRequest): Promise<{ completed: true; billingEnabled: false; memberEmailsEnabled: false; revision: number }>;
}

/**
 * Wizard step 8, "Import or start fresh". An import finish accepts only a committed (not dry-run)
 * import of this gym that has finished, then completes setup exactly as a fresh start does, so
 * billing and member emails stay off until the owner turns them on from go-live settings.
 */
export function createImportStep(options: { imports?: ImportRuns; scope?: typeof forGym; clock?: Clock }) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const invalid = () => new AppError('invalid_request', t('setup/import-step:invalidImport'));
  const missing = () => new AppError('not_found', t('setup/import-step:invalidImport'));
  // Deferring backups follows the payments step (6) instead of a confirmed backup step (7).
  async function current(tx: Transaction, context: MutationContext, revision: number, previousStep = 7) {
    const [gym] = await tx.select().from(gyms).where(eq(gyms.id, context.gymId)).for('update');
    const state = (gym?.settings as { setup?: { completed: boolean; completedSteps: number[]; ownerId?: string } } | undefined)?.setup;
    if (!gym || !state || state.completed || context.actor.kind !== 'user' || state.ownerId !== context.actor.userId)
      throw new AppError('not_found', t('setup/import-step:setupUnavailable'));
    assertRevised(gym.revision === revision ? [gym] : []);
    if (!state.completedSteps.includes(previousStep)) throw new AppError('conflict', t('setup/import-step:precedingStep'));
    return { gym, state };
  }
  async function verify(context: MutationContext, importId: string): Promise<ImportJob> {
    // Only committed runs write this audit row, keyed by the run ID, inside the gym's own scope.
    const [started] = await scope(context.gymId, (tx) => tx.select({ id: auditEvents.id }).from(auditEvents)
      .where(and(eq(auditEvents.gymId, context.gymId), eq(auditEvents.id, importId), eq(auditEvents.action, 'imports.started'))).limit(1));
    if (!started) throw missing();
    // Fail closed when the runtime has not supplied import progress.
    if (!options.imports) throw new AppError('unavailable', t('setup/import-step:unavailable'));
    let job: ImportJob;
    try { job = await options.imports.get(context.gymId, importId); }
    catch (error) { if (error instanceof AppError && error.code === 'not_found') throw missing(); throw error; }
    if (job.id !== importId || job.dryRun || job.status === 'failed') throw invalid();
    if (job.status !== 'succeeded') throw new AppError('conflict', t('setup/import-step:running'));
    return job;
  }
  return {
    verify,
    async finish(setup: SetupFinisher, context: MutationContext, input: SetupFinishRequest) {
      if (input.choice === 'fresh') return setup.finish(context, input);
      const previous = input.skipBackups ? 6 : 7;
      // Authorize before looking up progress; storage is called outside either transaction.
      await scope(context.gymId, (tx) => current(tx, context, input.revision, previous));
      const job = await verify(context, input.importId);
      return scope(context.gymId, async (tx) => {
        // Recheck under the write lock in case setup changed while reading import storage.
        const { gym, state } = await current(tx, context, input.revision, previous);
        const guard = revisionGuard(gyms.revision, input.revision);
        // As in a fresh finish, deferring backups clears any destination whose key was never confirmed.
        const backups = input.skipBackups ? { backupDestination: null, s3Config: null, backupPublicKey: null, backupBlobKey: null } : {};
        const after = assertRevised(await tx.update(gyms).set({ ...backups, billingEnabled: false, memberEmailsEnabled: false,
          settings: { ...gym.settings as object, setup: { ...state, completed: true,
            completedSteps: [...new Set([...state.completedSteps, 8])].sort((a, b) => a - b) } },
          revision: guard.next, updatedAt: clock.now(),
        }).where(and(eq(gyms.id, context.gymId), guard.matches)).returning({ revision: gyms.revision }));
        const actor = { gymId: context.gymId, actorKind: context.actor.kind,
          ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}), occurredAt: clock.now() };
        await writeAudit(tx, { ...actor, action: 'setup.step_completed', targetType: 'gym', targetId: context.gymId,
          after: { step: 8, revision: after.revision } });
        await writeAudit(tx, { ...actor, action: 'setup.import_selected', targetType: 'import', targetId: job.id,
          after: { mapper: job.mapper, committedRows: job.committedRows, billingEnabled: false, memberEmailsEnabled: false } });
        return { completed: true as const, billingEnabled: false as const, memberEmailsEnabled: false as const, revision: after.revision };
      });
    },
  };
}
export type ImportStep = ReturnType<typeof createImportStep>;

let configured: ImportStep | undefined;
/** The runtime passes the composed import pipeline; without it, import finishes fail closed. */
export function configureImportStep(options: Parameters<typeof createImportStep>[0]) { configured = createImportStep(options); }
export function importStep(): ImportStep { return configured ??= createImportStep({}); }
