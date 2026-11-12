// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { auditEvents, forGym, gyms, writeAudit } from '@plaingym/db';
import { AppError, createTranslator, type Clock } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { manualBackupSchema, type BackupControl, type ManualBackup } from '@plaingym/shared/contracts';
import { clock as systemClock } from '../../core/clock.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { tenancyMode } from '../../core/tenancy.js';
import { withJobTransaction, type Jobs, type JobRecovery } from '../../infra/jobs/index.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import { RestoreGate } from './restore.gate.js';
import { dirname } from 'node:path';
import { BackupsNotConfiguredError, InstallBackupGymCountError, loadBackupConfig } from './restore.config.js';

export const manualBackupJob = 'health.backup.manual';
const t = createTranslator(locales.en ?? {});
type Actor = { gymId: string; userId: string };
type Row = typeof gyms.$inferSelect;
const settingsOf = (row: Row) => row.settings as Record<string, unknown>;
const manualOf = (row: Row): ManualBackup | null => {
  const value = settingsOf(row).manualBackup;
  // Invalid stored state must not admit a second backup over an unknown first one.
  return value === undefined || value === null ? null : manualBackupSchema.parse(value);
};
export function createBackupControl(options: {
  scope?: typeof forGym; clock?: Clock; queue?: Jobs & Pick<JobRecovery, 'failedJobs'>; available?: () => boolean;
  isRestoring?: () => Promise<boolean>; configuredGym?: () => Promise<string | null>;
} = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? systemClock;
  const queue = options.queue ?? new PostgresJobs({ clock });
  const available = options.available ?? (() => tenancyMode() === 'single' && !!process.env.MAINTENANCE_DATABASE_URL && !!process.env.BACKUP_STAGING_DIR);
  const isRestoring = options.isRestoring ?? (async () => !!process.env.BACKUP_STAGING_DIR && await new RestoreGate(dirname(process.env.BACKUP_STAGING_DIR)).isClosed());
  const configuredGym = options.configuredGym ?? (async () => {
    try { return (await loadBackupConfig(parseEncryptionKey(process.env.APP_ENCRYPTION_KEY ?? ''))).gymId; }
    catch (error) { if (error instanceof BackupsNotConfiguredError || error instanceof InstallBackupGymCountError) return null; throw error; }
  });
  const read = async (tx: Parameters<Parameters<typeof forGym>[1]>[0], gymId: string, lock = false) => {
    const query = tx.select().from(gyms).where(eq(gyms.id, gymId));
    const [row] = await (lock ? query.for('update') : query);
    if (!row) throw new AppError('not_found', t('health/backups:notFound'));
    return row;
  };
  const present = (row: Row, configured: boolean): BackupControl => ({ available: available(), configured,
    pruningHeld: settingsOf(row).backupPruningHeld === true, revision: row.revision, manual: manualOf(row) });
  const ready = async (gymId: string) => available() && await configuredGym() === gymId;
  const recoverFailure = async (gymId: string) => {
    const pending = await scope(gymId, async tx => manualOf(await read(tx, gymId)));
    if (!pending || !['queued', 'running'].includes(pending.status)) return;
    const failed = await queue.failedJobs(manualBackupJob, [pending.requestId], { gymId });
    if (!failed.length) return;
    await scope(gymId, async tx => {
      const row = await read(tx, gymId, true), current = manualOf(row);
      if (current?.requestId !== pending.requestId || !['queued', 'running'].includes(current.status)) return;
      await tx.update(gyms).set({ settings: { ...settingsOf(row), manualBackup: { ...current,
        status: 'failed', completedAt: failed[0]!.failedAt.toISOString() } }, updatedAt: clock.now() }).where(eq(gyms.id, gymId));
      await writeAudit(tx, { gymId, actorKind: 'system', action: 'backup.failed', targetType: 'backup',
        targetId: current.requestId, after: { interrupted: true }, occurredAt: clock.now() });
    });
  };
  return {
    async get(gymId: string): Promise<BackupControl> {
      await recoverFailure(gymId);
      const configured = await ready(gymId);
      return scope(gymId, async tx => present(await read(tx, gymId), configured));
    },
    async request(actor: Actor, requestId: string): Promise<BackupControl> {
      if (await isRestoring()) throw new AppError('conflict', t('health/backups:restoring'));
      if (!await ready(actor.gymId)) throw new AppError('conflict', t('health/backups:notConfigured'));
      await recoverFailure(actor.gymId);
      return withJobTransaction(scope, actor.gymId, async transaction => {
        const { tx } = transaction, row = await read(tx, actor.gymId, true), previous = manualOf(row);
        if (previous?.requestId === requestId) return present(row, true);
        if (previous && ['queued', 'running'].includes(previous.status)) throw new AppError('conflict', t('health/backups:alreadyRunning'));
        const [used] = await tx.select({ id: auditEvents.id }).from(auditEvents)
          .where(and(eq(auditEvents.action, 'backup.requested'), eq(auditEvents.targetId, requestId))).limit(1);
        if (used) throw new AppError('conflict', t('health/backups:alreadyFinished'));
        const manual: ManualBackup = { requestId, status: 'queued', requestedAt: clock.now().toISOString(), completedAt: null, snapshotId: null };
        const [saved] = await tx.update(gyms).set({ settings: { ...settingsOf(row), manualBackup: manual }, updatedAt: clock.now() })
          .where(eq(gyms.id, actor.gymId)).returning();
        await queue.enqueue(manualBackupJob, { requestId }, { gymId: actor.gymId, timezone: row.timezone,
          idempotencyKey: requestId, maxAttempts: 1 }, transaction);
        await writeAudit(tx, { gymId: actor.gymId, actorKind: 'user', actorUserId: actor.userId,
          action: 'backup.requested', targetType: 'backup', targetId: requestId, after: manual, occurredAt: clock.now() });
        return present(saved!, true);
      });
    },
    async confirm(actor: Actor, revision: number): Promise<BackupControl> {
      if (!available() || await isRestoring()) throw new AppError('conflict', t('health/backups:unavailable'));
      const configured = await ready(actor.gymId);
      return scope(actor.gymId, async tx => {
        const row = await read(tx, actor.gymId, true);
        if (row.revision !== revision) throw new AppError('conflict', t('health/backups:changed'));
        if (settingsOf(row).backupPruningHeld !== true) return present(row, configured);
        const [saved] = await tx.update(gyms).set({ settings: { ...settingsOf(row), backupPruningHeld: false },
          revision: row.revision + 1, updatedAt: clock.now() }).where(eq(gyms.id, actor.gymId)).returning();
        await writeAudit(tx, { gymId: actor.gymId, actorKind: 'user', actorUserId: actor.userId,
          action: 'backup.old_server_gone_confirmed', targetType: 'gym', targetId: actor.gymId,
          before: { backupPruningHeld: true }, after: { backupPruningHeld: false }, occurredAt: clock.now() });
        return present(saved!, configured);
      });
    },
    async run(gymId: string, requestId: string, snapshot: () => Promise<{ id: string }>): Promise<void> {
      const update = (status: ManualBackup['status'], snapshotId: string | null = null) => scope(gymId, async tx => {
        const row = await read(tx, gymId, true), manual = manualOf(row);
        if (manual?.requestId !== requestId || manual.status === 'succeeded') return false;
        await tx.update(gyms).set({ settings: { ...settingsOf(row), manualBackup: { ...manual, status, snapshotId,
          completedAt: status === 'running' ? null : clock.now().toISOString() } }, updatedAt: clock.now() }).where(eq(gyms.id, gymId));
        if (status !== 'running') await writeAudit(tx, { gymId, actorKind: 'system', action: 'backup.' + status,
          targetType: 'backup', targetId: requestId, after: { snapshotId }, occurredAt: clock.now() });
        return true;
      });
      if (!await update('running')) return;
      try {
        if (await isRestoring() || !await ready(gymId)) throw new Error('Backups unavailable or restore in progress');
        const result = await snapshot(); await update('succeeded', result.id);
      }
      catch (error) { await update('failed'); throw error; }
    },
  };
}
