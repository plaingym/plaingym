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
import { FakeBackupObjectStore, FakeUploads } from '../../infra/storage/index.js';
import { BackupService, type BackupOptions } from './backups.js';
import type { PostgresMaintenance } from './backups.database.js';
import { bytesStream } from './backups.files.js';
import { backupFailureCause, markedStore, markStorageFailure, markUploadsFailure } from './backups.failure.js';
import { pruneUnlocked } from './backups.retention.js';

const unauthorized = { name: 'Unauthorized', $metadata: { httpStatusCode: 401 } };
const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
describe('backup failure causes', () => {
  it.each([
    ['a 401 answer', unauthorized, 'credentials_rejected'],
    ['a coded Unauthorized 401', { name: 'Unauthorized', Code: 'Unauthorized', $metadata: { httpStatusCode: 401 } }, 'credentials_rejected'],
    ['access denied', { name: 'AccessDenied', Code: 'AccessDenied', $metadata: { httpStatusCode: 403 } }, 'access_denied'],
    ['a bare 403', { name: 'Error', $metadata: { httpStatusCode: 403 } }, 'access_denied'],
    ['a bare 401', { name: 'Error', $metadata: { httpStatusCode: 401 } }, 'credentials_rejected'],
    ['a skewed clock', { name: 'RequestTimeTooSkewed', Code: 'RequestTimeTooSkewed', $metadata: { httpStatusCode: 403 } }, 'other'],
    ['a mismatched signature', { name: 'SignatureDoesNotMatch', Code: 'SignatureDoesNotMatch', $metadata: { httpStatusCode: 403 } }, 'credentials_rejected'],
    ['an unknown access key', { name: 'InvalidAccessKeyId', Code: 'InvalidAccessKeyId', $metadata: { httpStatusCode: 403 } }, 'credentials_rejected'],
    ['an invalid session token', { name: 'InvalidToken', Code: 'InvalidToken', $metadata: { httpStatusCode: 400 } }, 'credentials_rejected'],
    ['an expired session token', { name: 'ExpiredToken', Code: 'ExpiredToken', $metadata: { httpStatusCode: 400 } }, 'credentials_rejected'],
    ['a missing bucket', { name: 'NoSuchBucket', Code: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }, 'bucket_missing'],
    ['no answer from the server', { name: 'TimeoutError', $metadata: {} }, 'endpoint_unreachable'],
    ['an unmarked DNS lookup error', Object.assign(new Error('x'), { code: 'ENOTFOUND' }), 'other'],
    ['an unmarked connection reset', { code: 'ECONNRESET' }, 'other'],
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
    ['a broken pipe under the retry metadata', { code: 'EPIPE', $metadata: { attempts: 1 } }, 'endpoint_unreachable'],
    ['an aborted connection under the retry metadata', { code: 'ECONNABORTED', $metadata: { attempts: 1 } }, 'endpoint_unreachable'],
    ['a headers timeout under the retry metadata', { code: 'UND_ERR_HEADERS_TIMEOUT', $metadata: { attempts: 1 } }, 'endpoint_unreachable'],
    ['a body timeout under the retry metadata', { code: 'UND_ERR_BODY_TIMEOUT', $metadata: { attempts: 1 } }, 'endpoint_unreachable'],
    ['an unmarked bare broken pipe without retry metadata', { code: 'EPIPE' }, 'other'],
    ['an AbortError under the retry metadata', { name: 'AbortError', $metadata: { attempts: 1 } }, 'other'],
  ] as const)('classifies %s', (_, error, cause) => {
    expect(backupFailureCause(error)).toBe(cause);
  });
  it('classifies bare network codes as endpoint_unreachable once marked from storage, including under a wrapper', () => {
    for (const error of [
      { code: 'EPIPE' },
      { code: 'ECONNRESET' },
      Object.assign(new Error('x'), { code: 'ENOTFOUND' }),
    ]) {
      expect(backupFailureCause(error)).toBe('other');
      markStorageFailure(error);
      expect(backupFailureCause(error)).toBe('endpoint_unreachable');
      expect(backupFailureCause(new Error('Snapshot failed', { cause: error }))).toBe('endpoint_unreachable');
    }
  });
  it('marks store rejections and getObject stream read errors through markedStore', async () => {
    const store = new FakeBackupObjectStore(clock);
    const wrapped = markedStore(store);
    expect(markedStore(wrapped)).toBe(wrapped);

    const listReset = { code: 'ECONNRESET' };
    vi.spyOn(store, 'listObjects').mockRejectedValueOnce(listReset);
    const listError = await wrapped.listObjects('snapshots/').then(() => null, (error: unknown) => error);
    expect(listError).toBe(listReset);
    expect(backupFailureCause(listError)).toBe('endpoint_unreachable');

    const streamPipe = { code: 'EPIPE' };
    let pulled = false;
    vi.spyOn(store, 'getObject').mockResolvedValueOnce(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pulled) { pulled = true; controller.enqueue(new Uint8Array([1, 2, 3])); }
        else controller.error(streamPipe);
      },
    }));
    const body = await wrapped.getObject('blobs/x');
    expect(body).not.toBeNull();
    const readError = await new Response(body).arrayBuffer().then(() => null, (error: unknown) => error);
    expect(readError).toBe(streamPipe);
    expect(backupFailureCause(readError)).toBe('endpoint_unreachable');
  });
  it.each(['RequestTimeTooSkewed', 'AccountProblem', 'AllAccessDisabled', 'InvalidObjectState'])('calls a 403 %s other, not rejected credentials', (code) => {
    expect(backupFailureCause({ name: code, Code: code, $metadata: { httpStatusCode: 403 } })).toBe('other');
  });
  it('stops walking at the fifth level', () => {
    let error: unknown = unauthorized;
    for (let level = 0; level < 5; level++) error = new Error('wrapped', { cause: error });
    expect(backupFailureCause(error)).toBe('other');
  });
  it('classifies errors marked from uploads as other even with S3 metadata', () => {
    const accessDenied = { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } };
    expect(backupFailureCause(accessDenied)).toBe('access_denied');
    markUploadsFailure(accessDenied);
    expect(backupFailureCause(accessDenied)).toBe('other');
    expect(backupFailureCause(new Error('Snapshot failed', { cause: accessDenied }))).toBe('other');

    const resetFromUploads = { code: 'ECONNRESET', $metadata: {} };
    markUploadsFailure(resetFromUploads);
    expect(backupFailureCause(resetFromUploads)).toBe('other');
  });
});

const db = useTestDatabase(), clock = new TestClock('2026-11-22T12:00:00Z');
let root: string, recipient: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'backup-failure-')); recipient = await identityToRecipient(await generateIdentity()); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
beforeEach(async () => { await db.forSystem((tx) => tx.delete(backupRuns)); });
function service(store: FakeBackupObjectStore, dump: () => Promise<ReadableStream<Uint8Array>> = async () => bytesStream('database dump'),
  uploads: BackupOptions['uploads'] = async () => new Map()) {
  const database = { locked: <T>(action: () => Promise<T>) => action(), newId: () => uuidv7(), pruningHeld: async () => false,
    dump } as unknown as PostgresMaintenance;
  return new BackupService({ database, store, uploads, clock, recipient, appEncryptionKey: Buffer.alloc(32, 1),
    blobKey: Buffer.alloc(32, 2), stagingDirectory: join(root, 'staging'), scope: db });
}
async function failedSnapshot(store: FakeBackupObjectStore, dump?: () => Promise<ReadableStream<Uint8Array>>,
  uploads?: BackupOptions['uploads']) {
  const logs: string[] = [], previous = setLogSink((line) => logs.push(line));
  try { await expect(service(store, dump, uploads).snapshot('manual')).rejects.toThrow('Snapshot failed'); }
  finally { setLogSink(previous); }
  const runs = await db.forSystem((tx) => tx.select().from(backupRuns));
  return { runs, logs: logs.filter((line) => (JSON.parse(line) as { event: string }).event === 'backup.snapshot_failed') };
}
describe('a failed snapshot', () => {
  it('records other when the database dump fails with a bare EPIPE socket error', async () => {
    const store = new FakeBackupObjectStore(clock);
    const { runs, logs } = await failedSnapshot(store, async () => { throw { code: 'EPIPE' }; });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', error: 'other', completedAt: clock.now() });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ level: 'error', runId: runs[0]!.id, kind: 'manual', cause: 'other' });
  });
  it('records endpoint_unreachable when putObject rejects with a bare ECONNRESET on every attempt', async () => {
    const store = new FakeBackupObjectStore(clock);
    vi.spyOn(store, 'putObject').mockRejectedValue({ code: 'ECONNRESET' });
    const { runs, logs } = await failedSnapshot(store);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', error: 'endpoint_unreachable', completedAt: clock.now() });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ level: 'error', runId: runs[0]!.id, kind: 'manual', cause: 'endpoint_unreachable' });
  });
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
    vi.spyOn(store, 'putObject').mockRejectedValue({ name: 'SignatureDoesNotMatch', Code: 'SignatureDoesNotMatch', $metadata: { httpStatusCode: 403 } });
    const deletes = vi.spyOn(store, 'deleteObject');
    const { runs, logs } = await failedSnapshot(store);
    expect(runs[0]).toMatchObject({ status: 'failed', error: 'credentials_rejected' });
    expect(logs).toHaveLength(1);
    const prefix = runs[0]!.objectPrefix;
    expect(deletes.mock.calls.map(([key]) => key)).toEqual(['references.json', 'manifest.age', 'database.age'].map((name) => prefix + name));
  });
  it('records other when reading an uploads object rejects with an S3 403', async () => {
    const gymId = uuidv7(), uploadsSource = new FakeUploads(gymId, clock);
    await uploadsSource.put(`${gymId}/doc.pdf`, new Uint8Array([1, 2, 3]), 'application/pdf');
    vi.spyOn(uploadsSource, 'get').mockRejectedValueOnce({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    const { runs, logs } = await failedSnapshot(new FakeBackupObjectStore(clock), undefined, async () => new Map([[gymId, uploadsSource]]));
    expect(runs[0]).toMatchObject({ status: 'failed', error: 'other' });
    expect(JSON.parse(logs[0]!)).toMatchObject({ cause: 'other' });
  });
  // A run lists the uploads twice: first to prune, then to copy them into the snapshot.
  it.each([['pruning', 0], ['copying', 1]] as const)('records other when listing uploads for %s rejects with an S3 connection reset', async (_step, earlier) => {
    const gymId = uuidv7(), uploadsSource = new FakeUploads(gymId, clock);
    const list = vi.spyOn(uploadsSource, 'list');
    for (let call = 0; call < earlier; call++) list.mockResolvedValueOnce([]);
    list.mockRejectedValueOnce({ code: 'ECONNRESET', $metadata: {} });
    const { runs } = await failedSnapshot(new FakeBackupObjectStore(clock), undefined, async () => new Map([[gymId, uploadsSource]]));
    expect(list).toHaveBeenCalledTimes(earlier + 1);
    expect(runs[0]).toMatchObject({ status: 'failed', error: 'other' });
  });
  it('records other when reading an uploads body stream rejects with an S3 error', async () => {
    const gymId = uuidv7(), uploadsSource = new FakeUploads(gymId, clock);
    await uploadsSource.put(`${gymId}/doc.pdf`, new Uint8Array([1, 2, 3]), 'application/pdf');
    vi.spyOn(uploadsSource, 'get').mockResolvedValueOnce(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error({ code: 'ECONNRESET', $metadata: {} }); },
    }));
    const { runs } = await failedSnapshot(new FakeBackupObjectStore(clock), undefined, async () => new Map([[gymId, uploadsSource]]));
    expect(runs[0]).toMatchObject({ status: 'failed', error: 'other' });
  });
  it('classifies a pruneUnlocked uploads sweep S3 403 rejection as other', async () => {
    const gymId = uuidv7(), uploadsSource = new FakeUploads(gymId, clock);
    vi.spyOn(uploadsSource, 'sweep').mockRejectedValueOnce({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    const error = await pruneUnlocked(new FakeBackupObjectStore(clock), Buffer.alloc(32, 2), new Map([[gymId, uploadsSource]]), clock.now())
      .then(() => null, (err: unknown) => err);
    // The sweep's own rejection, so an earlier failure (also `other`) can't pass this.
    expect(error).toMatchObject({ name: 'AccessDenied' });
    expect(backupFailureCause(error)).toBe('other');
  });
});
