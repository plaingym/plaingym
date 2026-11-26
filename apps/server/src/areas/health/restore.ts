// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { markDownload, RestoreFailure, restoreTexts, s3Reason } from './restore.failure.js';
import { mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { auditEvents, backupRuns, gyms, uuidv7 } from '@plaingym/db';
// Restore infrastructure uses its dedicated maintenance connection, including in the standalone CLI.
// eslint-disable-next-line no-restricted-imports
import { openConnection, scopedDatabase } from '@plaingym/db/client';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { LocalUploads } from '../../infra/storage/index.js';
import type { BackupObjectStore, S3Uploads } from '../../infra/storage/index.js';
import { logInfo } from '../../core/log.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { PostgresMaintenance } from './backups.database.js';
import { atomicJson, childPath, exists, fileStream, missing, privateDirectory, readJson, saveStream } from './backups.files.js';
import { manifestSchema, publicReferences, readReferences, snapshotPrefix, validateReferences, verifyReferences } from './backups.format.js';
import type { Manifest } from './backups.format.js';
import { verifyFile } from './backups.js';
import { RestoreGate, readRestoreJournal, unfinishedRestorePhases } from './restore.gate.js';
import { manualBackupJob } from './restore.backup-control.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import { SnapshotContentError } from './backups.content.js';
import { decryptSnapshot, readSnapshotJson } from './restore.content.js';

/**
 * The columns of the restored tables the resume steps write or read. A newer release can resume a restore that an
 * older one stopped after rekeying, on a database its normal migration hasn't reached yet, so the steps below name
 * only columns that database has.
 */
async function readResumeColumns(connection: Pick<ReturnType<typeof openConnection>, 'sql'>) {
  const rows = await connection.sql<{ table_name: string; column_name: string }[]>`select table_name, column_name
    from information_schema.columns
    where table_schema = 'public' and table_name in ('jobs', 'audit_events', 'backup_runs', 'gyms')`;
  const present = new Set(rows.map(row => `${row.table_name}.${row.column_name}`));
  return { has: (table: string, column: string): boolean => present.has(`${table}.${column}`) };
}

const beforeAcknowledgement = 'This restore was started by a release before v0.8.0; resume it with that release, then update';
/** The resume steps set `jobs.acknowledged_at`, so a database without it is refused before they change anything. */
async function assertResumableSchema(database: PostgresMaintenance) {
  const connection = openConnection(database.url, 1);
  try {
    if (!(await readResumeColumns(connection)).has('jobs', 'acknowledged_at')) throw new RestoreFailure(beforeAcknowledgement);
  } finally { await connection.close(); }
}

/** Durable, idempotent publication before the restore journal can become complete. */
export async function enqueueRestoreReconciliation(database: PostgresMaintenance, snapshotAt: string, clock: Clock) {
  const connection = openConnection(database.url, 1);
  try {
    const scope = scopedDatabase(connection.db);
    // Enqueueing then names only the columns it sets, whatever later columns the restored `jobs` table lacks.
    const queue = new PostgresJobs({ database: scope, clock, failureCountColumn: false });
    for (const gymId of await database.gymIds()) {
      const request = await scope.forGym(gymId, async tx => {
        const [gym] = await tx.select({ timezone: gyms.timezone }).from(gyms).where(eq(gyms.id, gymId));
        // Maintenance bypasses RLS, so each query explicitly keeps the gym boundary.
        const [restore] = await tx.select({ id: auditEvents.id }).from(auditEvents)
          .where(and(eq(auditEvents.gymId, gymId), eq(auditEvents.action, 'restore.completed')))
          .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1);
        if (!gym || !restore) throw new RestoreFailure('Restored gym receipt is missing');
        const [published] = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
          eq(auditEvents.gymId, gymId), eq(auditEvents.action, 'billing.runner.restore_requested'), eq(auditEvents.targetId, restore.id))).limit(1);
        // Names only the columns it sets, and reads nothing back, so a later audit column doesn't break a resume.
        if (!published) await tx.execute(sql`insert into ${auditEvents}
            (id, gym_id, actor_kind, action, target_type, target_id, after, occurred_at)
          values (${uuidv7()}::uuid, ${gymId}::uuid, 'system', 'billing.runner.restore_requested', 'restore',
            ${restore.id}::uuid, ${JSON.stringify({ snapshotAt })}::jsonb, ${clock.now().toISOString()}::timestamptz)`);
        return { restoreId: restore.id, snapshotAt, timezone: gym.timezone };
      });
      await queue.enqueue('billing.runner.restore', { restoreId: request.restoreId, snapshotAt }, {
        gymId, timezone: request.timezone, idempotencyKey: `restore:${request.restoreId}`,
      });
    }
  } finally { await connection.close(); }
}

/**
 * A snapshot holds its own backup run, and a manual backup's job, as running. After the restore the snapshot's run
 * counts as succeeded (this restore just verified it), any other running run failed, and a backup job the snapshot
 * caught running failed and acknowledged. Changes only running rows, so a resumed restore can repeat it.
 */
export async function settleInterruptedBackups(database: PostgresMaintenance, snapshotId: string, clock: Clock) {
  const connection = openConnection(database.url, 1);
  try {
    const scope = scopedDatabase(connection.db);
    const runs = await scope.forSystem(async tx => {
      const settled = await tx.update(backupRuns).set({ status: 'succeeded', completedAt: clock.now() })
        .where(and(eq(backupRuns.id, snapshotId), eq(backupRuns.status, 'running'))).returning({ id: backupRuns.id });
      const failed = await tx.update(backupRuns).set({ status: 'failed', completedAt: clock.now(),
        error: 'Interrupted: the run was still in progress when this snapshot was taken' })
        .where(and(ne(backupRuns.id, snapshotId), eq(backupRuns.status, 'running'))).returning({ id: backupRuns.id });
      return settled.length + failed.length;
    });
    const columns = await readResumeColumns(connection);
    const jobs = await new PostgresJobs({ database: scope, clock, finishedAtColumn: columns.has('jobs', 'finished_at') })
      .failInterrupted([manualBackupJob, 'health.backup'], { at: clock.now(), reason: 'Interrupted by the restored snapshot',
        countFailure: columns.has('jobs', 'failure_count') });
    logInfo('restore.backups_settled', { runs, jobs });
  } finally { await connection.close(); }
}

const phaseSchema = z.enum([...unfinishedRestorePhases, 'complete']);
const stateSchema = z.strictObject({
  version: z.literal(1), id: z.uuid(), phase: phaseSchema, staging: z.string().regex(/^restore-[A-Za-z0-9]+$/),
  currentKey: z.string().regex(/^[a-f0-9]{64}$/),
  // Journals written before object-store restore have no target and restored into the directory.
  uploads: z.enum(['directory', 'store']).optional(),
});
export type RestorePhase = z.infer<typeof phaseSchema>;
const stagedFailure = 'The staged restore failed; preserve the restore state and check the server before retrying resume';
/** After a failed journal write: whether the journal names `staging` (true), doesn't (false), or can't be read (null). */
async function journalNames(path: string, staging: string): Promise<boolean | null> {
  try {
    const journal = await readJson(path);
    return typeof journal === 'object' && journal !== null && (journal as { staging?: unknown }).staging === staging;
  } catch (error) { return missing(error) ? false : null; }
}
export interface RestoreOptions {
  readonly database: PostgresMaintenance;
  readonly store: BackupObjectStore;
  readonly clock: Clock;
  readonly appEncryptionKey: Buffer;
  readonly stagingDirectory: string;
  readonly uploadsDirectory: string;
  /** Set when the install keeps uploads in S3: files are restored into the bucket instead of the directory. */
  readonly uploadsStore?: (gymId: string) => Promise<S3Uploads>;
  readonly gate: RestoreGate;
  /** Tests can simulate power loss at each durable transition. */
  readonly checkpoint?: (phase: RestorePhase | 'old_uploads_renamed' | 'new_uploads_renamed' | 'secret_field' | 'billing_reconciliation_queued') => void;
}
export class RestoreService {
  constructor(readonly options: RestoreOptions) {
    if (options.appEncryptionKey.length !== 32) throw new RestoreFailure('Invalid current app key');
    if (resolve(options.uploadsDirectory) === resolve(options.stagingDirectory) ||
        resolve(options.stagingDirectory).startsWith(resolve(options.uploadsDirectory) + sep))
      throw new RestoreFailure('Restore staging must be outside uploads');
  }
  async #download(key: string, path: string, missing: string = restoreTexts.objectMissing): Promise<void> {
    // Marked so a network code from the bucket or its body stream names the endpoint; the same error is rethrown.
    try {
      const body = await this.options.store.getObject(key);
      if (!body) throw new RestoreFailure(missing);
      await saveStream(path, body);
    } catch (error) { markDownload(error); throw error; }
  }
  /** Under the backup lock, after the journal proves no unfinished restore needs these plaintext folders. */
  async #sweepStaging(): Promise<void> {
    let entries;
    try { entries = await readdir(this.options.stagingDirectory, { withFileTypes: true }); }
    catch (error) { if (missing(error)) return; throw error; }
    for (const entry of entries) if (entry.isDirectory() && /^restore-[A-Za-z0-9]+$/.test(entry.name))
      await rm(childPath(this.options.stagingDirectory, entry.name), { recursive: true, force: true });
  }
  async restore(id: string, identity: string): Promise<void> {
    assertNoTransaction('restore.begin'); z.uuid().parse(id);
    const o = this.options;
    const verified = await o.database.locked(async () => {
      if (await o.gate.isClosed()) throw new RestoreFailure('A verified restore is already staged; resume it first');
      await privateDirectory(o.stagingDirectory);
      await this.#sweepStaging();
      const staging = await mkdtemp(join(o.stagingDirectory, 'restore-'));
      await privateDirectory(dirname(resolve(o.uploadsDirectory)));
      if (!o.uploadsStore && (await stat(staging)).dev !== (await stat(dirname(resolve(o.uploadsDirectory)))).dev) {
        await rm(staging, { recursive: true, force: true });
        throw new RestoreFailure('Restore staging and uploads must share a filesystem');
      }
      const prefix = snapshotPrefix(id);
      // Set once the journal may name this staging: from then on only a finished or resumed restore removes it.
      let activated = false;
      try {
        const manifestCipher = join(staging, 'manifest.age');
        await this.#download(prefix + 'manifest.age', manifestCipher, restoreTexts.snapshotMissing);
        await saveStream(join(staging, 'manifest.json'), await decryptSnapshot(identity, fileStream(manifestCipher)));
        const manifest = manifestSchema.parse(await readSnapshotJson(join(staging, 'manifest.json')));
        if (manifest.id !== id) throw new RestoreFailure('Manifest belongs to another snapshot');
        const blobKey = parseEncryptionKey(manifest.recovery.blobKey);
        validateReferences(manifest.uploads, blobKey);
        let referenceValue: unknown;
        try { referenceValue = await readReferences(o.store, prefix + 'references.json'); }
        catch (error) { markDownload(error); throw error; }
        const references = verifyReferences(referenceValue, blobKey, id);
        await atomicJson(join(staging, 'references.json'), referenceValue);
        if (JSON.stringify(references.uploads) !== JSON.stringify(publicReferences(manifest.uploads, blobKey)) ||
            JSON.stringify(references.database) !== JSON.stringify(manifest.database.encrypted) ||
            references.kind !== manifest.kind || references.startedAt !== manifest.startedAt)
          throw new RestoreFailure('Manifest and authenticated references disagree');
        await verifyFile(manifestCipher, references.manifest);
        await this.#download(prefix + 'database.age', join(staging, 'database.age'));
        await verifyFile(join(staging, 'database.age'), references.database);
        await saveStream(join(staging, 'database.dump'), await decryptSnapshot(identity, fileStream(join(staging, 'database.age'))));
        await verifyFile(join(staging, 'database.dump'), manifest.database.plaintext);
        // Prepare a complete new LocalUploads tree without opening or modifying the current uploads tree,
        // or, for an object store, verified plaintext files to publish once the database is restored.
        const uploadTree = join(staging, o.uploadsStore ? 'objects' : 'uploads');
        await privateDirectory(uploadTree);
        for (const [index, upload] of manifest.uploads.entries()) {
          const cipher = join(staging, 'blob-' + index + '.age'), plain = join(staging, 'blob-' + index);
          await this.#download(upload.blob, cipher);
          await verifyFile(cipher, upload.encrypted);
          await saveStream(plain, await decryptSnapshot(identity, fileStream(cipher)));
          await verifyFile(plain, upload.plaintext);
          if (o.uploadsStore) { await rm(cipher); await rename(plain, join(uploadTree, String(index))); continue; }
          const local = new LocalUploads({ gymId: upload.gymId, root: uploadTree,
            signingKey: o.appEncryptionKey, downloadUrl: 'https://restore.invalid/uploads',
            clock: { now: () => new Date(upload.createdAt) } });
          await local.put(upload.key, fileStream(plain), upload.contentType);
          await rm(cipher); await rm(plain);
        }
        const state = { version: 1 as const, id, phase: 'verified' as RestorePhase, staging: basename(staging),
          currentKey: createHash('sha256').update(o.appEncryptionKey).digest('hex'),
          uploads: o.uploadsStore ? 'store' as const : 'directory' as const };
        // Durable activation closes admission on every process sharing this data volume.
        try { await atomicJson(o.gate.statePath, state); }
        catch (error) {
          // The rename may have published the journal before the directory sync failed (EIO, EMFILE). It is then
          // active and `resume` needs this staging; one that can't be read back might be, so its staging stays too.
          const published = await journalNames(o.gate.statePath, state.staging);
          activated = published !== false;
          if (published === null) throw new RestoreFailure('A restore may be staged; preserve the restore state and run resume', { cause: error });
          if (published) throw new RestoreFailure(stagedFailure, { cause: error });
          throw error;
        }
        activated = true;
        return { state, manifest };
      } catch (error) {
        if (error instanceof SnapshotContentError)
          throw new RestoreFailure(restoreTexts.damaged, { cause: error.cause ?? error });
        throw error;
      } finally {
        if (!activated) await rm(staging, { recursive: true, force: true });
      }
    });
    // Release the backup lock before draining: an admitted worker may already be
    // waiting for that lock. Admission is closed durably by the verified journal.
    await o.gate.close();
    o.checkpoint?.('verified');
    await this.#staged(() => o.database.locked(() => this.#resume(verified.state, verified.manifest)));
  }
  async resume(): Promise<void | 'staging_sweep_skipped'> {
    const o = this.options;
    if (!await exists(o.gate.statePath)) {
      // Cleanup is optional at startup: don't wait behind an active snapshot. Recheck the journal under the lock.
      const swept = await o.database.tryLocked(async () => {
        if (await exists(o.gate.statePath)) return false;
        await this.#sweepStaging(); return true;
      });
      if (swept === undefined) {
        logInfo('restore.staging_sweep_skipped', { reason: 'backup_lock_busy' });
        return 'staging_sweep_skipped';
      }
      if (swept) return;
    }
    await o.gate.close();
    await this.#staged(() => o.database.locked(async () => {
      const journal = stateSchema.safeParse(await readRestoreJournal(o.gate.statePath));
      if (!journal.success) throw new RestoreFailure('The restore journal is not in a format this version reads');
      const state = journal.data;
      if (state.phase === 'complete') {
        await rm(resolve(o.uploadsDirectory) + '.previous-' + state.id, { recursive: true, force: true });
        await this.#sweepStaging();
        o.gate.reopen(); return;
      }
      const staging = childPath(o.stagingDirectory, state.staging);
      const manifest = manifestSchema.parse(await readJson(join(staging, 'manifest.json')));
      if (manifest.id !== state.id) throw new RestoreFailure('Restore journal does not match staged snapshot');
      verifyReferences(await readJson(join(staging, 'references.json')), parseEncryptionKey(manifest.recovery.blobKey), state.id);
      await verifyFile(join(staging, 'database.dump'), manifest.database.plaintext);
      await this.#resume(state, manifest);
    }));
  }
  async #staged(action: () => Promise<void>): Promise<void> {
    try { await action(); }
    catch (error) {
      if (error instanceof RestoreFailure) throw error;
      // After activation only the install's uploads bucket is an S3 store: the snapshot is already staged.
      const s3 = s3Reason(error, 'uploads');
      throw new RestoreFailure(s3 ? 'The staged restore failed: ' + s3.charAt(0).toLowerCase() + s3.slice(1)
        + '; preserve the restore state, fix the uploads bucket, then retry resume' : stagedFailure, { cause: error });
    }
  }
  async #resume(state: z.infer<typeof stateSchema>, manifest: Manifest): Promise<void> {
    const o = this.options, staging = childPath(o.stagingDirectory, state.staging);
    if (state.currentKey !== createHash('sha256').update(o.appEncryptionKey).digest('hex'))
      throw new RestoreFailure('Current install key changed during restore');
    if ((state.uploads ?? 'directory') !== (o.uploadsStore ? 'store' : 'directory'))
      throw new RestoreFailure('Upload storage changed during restore');
    const save = async (phase: RestorePhase) => {
      state.phase = phase; await atomicJson(o.gate.statePath, state); o.checkpoint?.(phase);
    };
    if (['verified', 'database_restored', 'migrated'].includes(state.phase)) {
      // Restart from the verified dump unless the rekey receipt was durably published.
      // Resetting makes both a committed pg_restore and an interrupted rekey repeatable.
      await o.database.restore(join(staging, 'database.dump'));
      await save('database_restored');
      await o.database.migrate(); // Includes applySecurity and the catalog assertion.
      await save('migrated');
      await o.database.rekey(parseEncryptionKey(manifest.recovery.appEncryptionKey), o.appEncryptionKey, o.clock,
        () => o.checkpoint?.('secret_field'));
      await save('rekeyed');
    }
    // A journal past the rekey resumes on the schema the release that wrote it migrated to.
    await assertResumableSchema(o.database);
    const current = resolve(o.uploadsDirectory), previous = current + '.previous-' + state.id;
    // Staging and uploads must be on the same data volume so both renames are atomic.
    await privateDirectory(dirname(current));
    if (state.phase === 'rekeyed') await save('moving_old');
    if (state.phase === 'moving_old' && o.uploadsStore) {
      // Files uploaded after the snapshot are unreferenced once it is restored: mark them deleted, as the
      // directory restore discards the old tree, so a later sweep removes them.
      const restored = new Set(manifest.uploads.map((upload) => upload.key));
      for (const gymId of await o.database.gymIds()) {
        const store = await o.uploadsStore(gymId);
        for (const upload of await store.list()) if (!restored.has(upload.key) && !upload.deletedAt) await store.markDeleted(upload.key);
      }
      o.checkpoint?.('old_uploads_renamed');
      await save('moving_new');
    }
    if (state.phase === 'moving_new' && o.uploadsStore) {
      // Idempotent per file, so a resumed restore repeats this step from the start.
      for (const [index, upload] of manifest.uploads.entries()) {
        const plain = join(staging, 'objects', String(index));
        await verifyFile(plain, upload.plaintext);
        await (await o.uploadsStore(upload.gymId)).restore(upload.key, fileStream(plain), upload.contentType, new Date(upload.createdAt));
      }
      o.checkpoint?.('new_uploads_renamed');
      await save('uploads_switched');
    }
    if (state.phase === 'moving_old') {
      if (!await exists(previous) && await exists(current)) {
        await rename(current, previous); o.checkpoint?.('old_uploads_renamed');
      }
      await save('moving_new');
    }
    if (state.phase === 'moving_new') {
      if (await exists(join(staging, 'uploads'))) {
        if (await exists(current)) throw new RestoreFailure('Unexpected uploads directory during restore');
        await rename(join(staging, 'uploads'), current); o.checkpoint?.('new_uploads_renamed');
      } else if (!await exists(current)) throw new RestoreFailure('Restored uploads tree missing');
      await save('uploads_switched');
    }
    if (state.phase === 'uploads_switched') {
      await settleInterruptedBackups(o.database, manifest.id, o.clock);
      await enqueueRestoreReconciliation(o.database, manifest.startedAt, o.clock);
      o.checkpoint?.('billing_reconciliation_queued');
      await save('complete');
    }
    if (state.phase === 'complete') {
      await rm(previous, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
      o.gate.reopen();
    }
  }
}
