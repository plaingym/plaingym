// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TestClock } from '../../core/clock.js';
import { AgeKeyMismatchError, generateIdentity } from '../../infra/age/index.js';
import { FakeBackupObjectStore } from '../../infra/storage/index.js';
import type { PostgresMaintenance } from './backups.database.js';
import { RestoreService } from './restore.js';
import { RestoreGate } from './restore.gate.js';
import { markDownload, RestoreFailure, restoreFailureClass } from './restore.failure.js';

const s3Error = (fields: Record<string, unknown>) => Object.assign(new Error('x'), fields);

describe('restoreFailureClass', () => {
  it('names rejected credentials', () => {
    for (const code of ['SignatureDoesNotMatch', 'InvalidAccessKeyId']) {
      expect(restoreFailureClass(s3Error({ name: code, Code: code, $metadata: { httpStatusCode: 403 } }))).toBe('credentials_rejected');
    }
  });
  it('names a missing bucket', () => {
    expect(restoreFailureClass({ name: 'NoSuchBucket', Code: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } })).toBe('bucket_missing');
  });
  it('names a missing snapshot', () => {
    expect(restoreFailureClass({ name: 'NoSuchKey', Code: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })).toBe('snapshot_missing');
    expect(restoreFailureClass({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })).toBe('snapshot_missing');
    expect(restoreFailureClass(new RestoreFailure('A snapshot object is missing from the bucket'))).toBe('snapshot_missing');
  });
  it('names an endpoint that never answered', () => {
    expect(restoreFailureClass(Object.assign(new Error('connect'), { code: 'ECONNREFUSED', $metadata: { attempts: 3 } }))).toBe('endpoint_unreachable');
  });
  it('names the endpoint for a bare network code only when it came from a snapshot download', () => {
    const refused = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
    // Such as the maintenance database refusing the lock the restore takes before any storage call.
    expect(restoreFailureClass(refused)).toBe('other');
    markDownload(refused);
    expect(restoreFailureClass(refused)).toBe('endpoint_unreachable');
    expect(restoreFailureClass(new Error('Snapshot read failed', { cause: s3Error({ name: 'TimeoutError', $metadata: { attempts: 3 } }) }))).toBe('endpoint_unreachable');
  });
  it('names the endpoint for a body stream reset during a download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restore-download-'));
    try {
      const store = new FakeBackupObjectStore();
      const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      vi.spyOn(store, 'getObject').mockResolvedValue(new ReadableStream({ pull(controller) { controller.error(reset); } }));
      const database = { locked: <T>(action: () => Promise<T>) => action() } as unknown as PostgresMaintenance;
      const service = new RestoreService({ database, store, clock: new TestClock('2026-11-23T12:00:00Z'), appEncryptionKey: Buffer.alloc(32, 1),
        stagingDirectory: join(root, 'staging'), uploadsDirectory: join(root, 'uploads'), gate: new RestoreGate(join(root, 'data')) });
      const error: unknown = await service.restore(randomUUID(), await generateIdentity()).then(() => null, (failure: unknown) => failure);
      expect(error).toBe(reset);
      expect(restoreFailureClass(error)).toBe('endpoint_unreachable');
      expect((await readdir(join(root, 'staging'))).filter((name) => name.startsWith('restore-'))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('names the private key problems', () => {
    expect(restoreFailureClass(new AgeKeyMismatchError(new Error('no match')))).toBe('wrong_key');
    expect(restoreFailureClass(new Error('Invalid age private key'))).toBe('invalid_key');
  });
  it('names a damaged snapshot and contents this version cannot read', () => {
    expect(restoreFailureClass(new RestoreFailure('The snapshot is damaged; try an earlier one'))).toBe('damaged');
    expect(restoreFailureClass(z.object({ a: z.number() }).safeParse({ a: 'b' }).error)).toBe('unsupported');
  });
  it('calls anything else other', () => {
    expect(restoreFailureClass(new RestoreFailure('Restore staging and uploads must share a filesystem'))).toBe('other');
    expect(restoreFailureClass(new Error('disk full'))).toBe('other');
    expect(restoreFailureClass('text')).toBe('other');
  });
  it("doesn't read a staged failure's cause", () => {
    const cause = s3Error({ name: 'AccessDenied', Code: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    expect(restoreFailureClass(new RestoreFailure('The staged restore failed', { cause }))).toBe('other');
  });
});
