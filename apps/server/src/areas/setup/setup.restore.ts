// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { uuidv7 } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { setupRestoreResponseSchema, type SetupRestoreRequest, type SetupRestoreResponse } from '@plaingym/shared/contracts';
import { clock } from '../../core/clock.js';
import { restoreStagingDirectory } from '../../core/maintenance-credentials.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { createS3Client, S3BackupObjectStore } from '../../infra/storage/index.js';
import { RestoreService } from '../health/restore.js';
import { createRuntimeUploads } from '../../infra/storage/runtime.js';
import { RestoreGate } from '../health/restore.gate.js';
import { PostgresMaintenance } from '../health/backups.database.js';
import { atomicJson } from '../health/backups.files.js';
import { processAlive, processStart, type ProcessLease } from './setup.process.js';

type Result = SetupRestoreResponse['data'];
export function snapshotId(prefix: string): string {
  const match = /^(?:snapshots\/)?([a-f0-9-]{36})\/?$/.exec(prefix);
  if (!match) throw new AppError('invalid_request', 'Invalid snapshot prefix');
  return z.uuid().parse(match[1]);
}
export function createSetupRestore(options: {
  assertEmpty(): Promise<void>; restore(input: SetupRestoreRequest): Promise<void>;
  claim?: (token: string) => Promise<{ reservationId: string; release(): Promise<void> }>;
  onRestored?: () => Promise<void>;
  onInterrupted?: (reservationId: string) => Promise<void>;
  journal?: string; gate?: RestoreGate; clock?: Clock;
}) {
  let active = false;
  let result: Result | undefined;
  let restoringSnapshot: string | undefined;
  let reservationId: string | undefined;
  let owner: ProcessLease | undefined;
  async function publish(value: Result) {
    if (options.journal) await atomicJson(options.journal, { result: value, snapshotId: restoringSnapshot, reservationId, owner });
    result = value;
  }
  return {
    async start(input: SetupRestoreRequest): Promise<Result> {
      const snapshot = snapshotId(input.snapshotPrefix);
      if (active) throw new AppError('conflict', 'A restore is already running');
      active = true;
      let release: (() => Promise<void>) | undefined;
      let jobId: string | undefined;
      try {
        await options.assertEmpty();
        restoringSnapshot = snapshot;
        reservationId = uuidv7((options.clock ?? clock).now().getTime());
        owner = { pid: process.pid, started: await processStart(process.pid) };
        const claim = await options.claim?.(reservationId);
        release = claim?.release;
        jobId = uuidv7((options.clock ?? clock).now().getTime());
        await publish({ status: 'running', jobId, phase: 'verifying' });
        const pollingId = jobId;
        // This promise owns the supplied identity until verification finishes; it is never journaled.
        void (async () => {
          try {
            await options.restore(input);
            await options.onRestored?.();
            await release?.(); release = undefined;
            active = false;
            await publish({ status: 'restored', jobId: pollingId, billingEnabled: false, next: 'login' });
          } catch (error) {
            // Operators need the cause; the owner-facing status stays generic. Never log the input or its key.
            console.error('Setup restore failed:', error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error');
            await publish({ status: 'failed', jobId: pollingId, message: 'Restore failed. Check the source and private key, or resume a verified restore.' });
          } finally {
            // A verified but interrupted restore retains its reservation until maintenance resumes it.
            if (!options.gate || !await options.gate.isClosed()) await release?.();
            active = false;
          }
        })().catch(() => { active = false; });
        return { status: 'running', jobId, phase: 'verifying' };
      } catch (error) {
        try {
          await release?.();
          if (jobId) await publish({ status: 'failed', jobId, message: 'Restore could not start.' });
        } finally { active = false; }
        throw error;
      }
    },
    async status(jobId: string): Promise<Result> {
      let saved = result;
      if (!saved && options.journal) {
        try {
          const journal = z.object({ result: setupRestoreResponseSchema.shape.data, snapshotId: z.uuid(), reservationId: z.uuid().optional(),
            owner: z.object({ pid: z.number().int().positive(), started: z.string().nullable() }).optional() }).parse(JSON.parse(await readFile(options.journal, 'utf8')));
          saved = journal.result; restoringSnapshot = journal.snapshotId; reservationId = journal.reservationId; owner = journal.owner;
        }
        catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
      }
      if (!saved || saved.jobId !== jobId) throw new AppError('not_found', 'Restore not found');
      if (saved.status !== 'restored' && options.gate) {
        // The maintenance entrypoint resumes a verified journal before opening HTTP after restart.
        let state: { id: string; phase: string } | undefined;
        try {
          state = JSON.parse(await readFile(options.gate.statePath, 'utf8')) as { id: string; phase: string };
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        }
        if (state && state.id === restoringSnapshot && state.phase === 'complete') {
          // A live coordinator still owns cleanup and completion; peers wait for its final journal.
          if (saved.status === 'running' && (active || (owner && await processAlive(owner)))) return saved;
          await options.onRestored?.();
          saved = { status: 'restored', jobId, billingEnabled: false, next: 'login' };
          await publish(saved);
        } else if (state && state.id === restoringSnapshot) {
          if (saved.status === 'running') saved = { ...saved, phase: state.phase === 'verified' ? 'database' : state.phase === 'database_restored' || state.phase === 'migrated' ? 'secrets' : 'uploads' };
        } else {
          const alive = active || (saved.status === 'running' && owner !== undefined && await processAlive(owner));
          if (!alive) {
            if (reservationId) await options.onInterrupted?.(reservationId);
            saved = { status: 'failed', jobId, message: 'Restore verification was interrupted. Start again.' };
            await publish(saved);
          }
        }
      }
      return saved;
    },
    async recover() {
      if (active || !options.journal) return;
      try {
        const journal = z.object({ result: setupRestoreResponseSchema.shape.data }).parse(JSON.parse(await readFile(options.journal, 'utf8')));
        if (journal.result.status !== 'restored') await this.status(journal.result.jobId);
      } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
    },
  };
}

export function defaultSetupRestore(service: {
  assertEmpty(): Promise<void>; reserveRestore(token: string): Promise<{ reservationId: string; release(): Promise<void> }>;
  releaseRestore(reservationId: string): Promise<void>; markRestored(): Promise<void>;
}) {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new AppError('unavailable', 'Restore is not configured');
    return value;
  };
  // A multi-gym app never restores: it has no staging directory even when one is set by hand.
  const stagingDirectory = restoreStagingDirectory(process.env);
  if (!stagingDirectory) throw new AppError('unavailable', 'Restore is not configured');
  const gate = new RestoreGate(dirname(stagingDirectory));
  return createSetupRestore({ assertEmpty: () => service.assertEmpty(), claim: (token) => service.reserveRestore(token), onRestored: () => service.markRestored(),
    onInterrupted: (id) => service.releaseRestore(id), gate, journal: join(gate.dataDirectory, 'setup-restore.json'),
    async restore(input) {
      const client = createS3Client({ endpoint: input.source.endpoint, region: input.source.region,
        credentials: { accessKeyId: input.source.accessKeyId, secretAccessKey: input.source.secretAccessKey } });
      const appEncryptionKey = parseEncryptionKey(required('APP_ENCRYPTION_KEY'));
      // Files go back wherever this install keeps uploads: its directory or its S3 bucket.
      const uploads = createRuntimeUploads(process.env, appEncryptionKey, async () => 'https://restore.invalid');
      try {
        await new RestoreService({ store: new S3BackupObjectStore({ client, bucket: input.source.bucket, clock }),
          database: new PostgresMaintenance(required('MAINTENANCE_DATABASE_URL')), clock,
          appEncryptionKey, stagingDirectory, uploadsDirectory: required('UPLOADS_DIR'), gate,
          ...(uploads.restoreStore ? { uploadsStore: uploads.restoreStore } : {}),
        }).restore(snapshotId(input.snapshotPrefix), input.privateKey);
      } finally { client.destroy(); uploads.close(); }
    },
  });
}
