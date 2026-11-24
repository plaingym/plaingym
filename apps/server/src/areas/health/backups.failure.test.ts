// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupRuns, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { TestClock } from '../../core/clock.js';
import { setLogSink } from '../../core/log.js';
import { generateIdentity, identityToRecipient } from '../../infra/age/index.js';
import { FakeBackupObjectStore } from '../../infra/storage/index.js';
import { BackupService } from './backups.js';
import type { PostgresMaintenance } from './backups.database.js';
import { bytesStream } from './backups.files.js';
import { backupFailureCause } from './backups.failure.js';

const unauthorized = { name: 'Unauthorized', $metadata: { httpStatusCode: 401 } };
const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
describe('backup failure causes', () => {
  it.each([
    ['a 401 answer', unauthorized, 'credentials_rejected'],
    ['access denied', { name: 'AccessDenied', Code: 'AccessDenied', $metadata: { httpStatusCode: 403 } }, 'credentials_rejected'],
    ['a missing bucket', { name: 'NoSuchBucket', Code: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }, 'bucket_missing'],
    ['no answer from the server', { name: 'TimeoutError', $metadata: {} }, 'endpoint_unreachable'],
    ['a failed DNS lookup', Object.assign(new Error('x'), { code: 'ENOTFOUND' }), 'endpoint_unreachable'],
    ['a chained upload failure', new Error('Snapshot failed', { cause: new Error('Backup object upload failed', { cause: unauthorized }) }), 'credentials_rejected'],
    ['a server error', { name: 'InternalError', Code: 'InternalError', $metadata: { httpStatusCode: 500 } }, 'other'],
    ['a local error', new Error('disk full'), 'other'],
    ['a non-object', 'Unauthorized', 'other'],
    ['an upload whose abort failed too', new AggregateError([unauthorized, reset], 'S3 multipart upload and abort failed', { cause: reset }), 'credentials_rejected'],
    ['a TLS certificate error the retry step added metadata to', { name: 'Error', $metadata: { attempts: 1 }, code: 'CERT_HAS_EXPIRED' }, 'other'],
    ['a timeout after retries', { name: 'TimeoutError', $metadata: { attempts: 3 } }, 'endpoint_unreachable'],
    ['a refused connection under the retry metadata', { name: 'Error', $metadata: { attempts: 3 }, cause: { code: 'ECONNREFUSED' } }, 'endpoint_unreachable'],
    ['an unroutable host under the retry metadata', { name: 'Error', $metadata: { attempts: 3 }, code: 'EHOSTUNREACH' }, 'endpoint_unreachable'],
    ['an unreachable network under the retry metadata', { name: 'Error', $metadata: { attempts: 3 }, code: 'ENETUNREACH' }, 'endpoint_unreachable'],
  ] as const)('classifies %s', (_, error, cause) => {
    expect(backupFailureCause(error)).toBe(cause);
  });
  it.each(['RequestTimeTooSkewed', 'AccountProblem', 'AllAccessDisabled', 'InvalidObjectState'])('calls a 403 %s other, not rejected credentials', (code) => {
    expect(backupFailureCause({ name: code, Code: code, $metadata: { httpStatusCode: 403 } })).toBe('other');
  });
  it('stops walking at the fifth level', () => {
    let error: unknown = unauthorized;
    for (let level = 0; level < 5; level++) error = new Error('wrapped', { cause: error });
    expect(backupFailureCause(error)).toBe('other');
  });
});

const db = useTestDatabase(), clock = new TestClock('2026-11-22T12:00:00Z');
let root: string, recipient: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'backup-failure-')); recipient = await identityToRecipient(await generateIdentity()); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
beforeEach(async () => { await db.forSystem((tx) => tx.delete(backupRuns)); });
function service(store: FakeBackupObjectStore) {
  const database = { locked: <T>(action: () => Promise<T>) => action(), newId: () => uuidv7(), pruningHeld: async () => false,
    dump: async () => bytesStream('database dump') } as unknown as PostgresMaintenance;
  return new BackupService({ database, store, uploads: async () => new Map(), clock, recipient, appEncryptionKey: Buffer.alloc(32, 1),
    blobKey: Buffer.alloc(32, 2), stagingDirectory: join(root, 'staging'), scope: db });
}
async function failedSnapshot(store: FakeBackupObjectStore) {
  const logs: string[] = [], previous = setLogSink((line) => logs.push(line));
  try { await expect(service(store).snapshot('manual')).rejects.toThrow('Snapshot failed'); }
  finally { setLogSink(previous); }
  const runs = await db.forSystem((tx) => tx.select().from(backupRuns));
  return { runs, logs: logs.filter((line) => (JSON.parse(line) as { event: string }).event === 'backup.snapshot_failed') };
}
describe('a failed snapshot', () => {
  it('is recorded and logged with its cause when the destination refuses every call, deletes included', async () => {
    const store = new FakeBackupObjectStore(clock);
    const rejected = Object.assign(new Error('upstream text quoting the key'), unauthorized);
    vi.spyOn(store, 'listObjects').mockRejectedValue(rejected);
    vi.spyOn(store, 'putObject').mockRejectedValue(rejected);
    const deletes = vi.spyOn(store, 'deleteObject').mockRejectedValue(rejected);
    const { runs, logs } = await failedSnapshot(store);
    // The refused reference list delete stops the cleanup: the objects it may name stay with it.
    expect(deletes.mock.calls.map(([key]) => key)).toEqual([runs[0]!.objectPrefix + 'references.json']);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', error: 'credentials_rejected', completedAt: clock.now() });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ level: 'error', runId: runs[0]!.id, kind: 'manual', cause: 'credentials_rejected' });
    expect(logs[0]).not.toContain('upstream text');
  });
  it('still removes the uncommitted objects when only the upload fails', async () => {
    const store = new FakeBackupObjectStore(clock);
    vi.spyOn(store, 'putObject').mockRejectedValue(unauthorized);
    const deletes = vi.spyOn(store, 'deleteObject');
    const { runs, logs } = await failedSnapshot(store);
    expect(runs[0]).toMatchObject({ status: 'failed', error: 'credentials_rejected' });
    expect(logs).toHaveLength(1);
    const prefix = runs[0]!.objectPrefix;
    expect(deletes.mock.calls.map(([key]) => key)).toEqual(['references.json', 'manifest.age', 'database.age'].map((name) => prefix + name));
  });
});
