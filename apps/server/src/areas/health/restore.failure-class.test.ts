// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TestClock } from '../../core/clock.js';
import { AgeKeyMismatchError, encrypt, generateIdentity, identityToRecipient } from '../../infra/age/index.js';
import { FakeBackupObjectStore } from '../../infra/storage/index.js';
import type { PostgresMaintenance } from './backups.database.js';
import { bytesStream } from './backups.files.js';
import { blobName, publicReferences, signReferences, snapshotPrefix, type Manifest } from './backups.format.js';
import { RestoreService } from './restore.js';
import { RestoreGate } from './restore.gate.js';
import { markDownload, RestoreFailure, restoreFailureClass, restoreTexts } from './restore.failure.js';

const s3Error = (fields: Record<string, unknown>) => Object.assign(new Error('x'), fields);

async function seedSnapshot(store: FakeBackupObjectStore, options: { withDatabase?: boolean; withUpload?: boolean } = {}) {
  const id = randomUUID(), identity = await generateIdentity(), recipient = await identityToRecipient(identity);
  const blobKey = Buffer.alloc(32, 2), prefix = snapshotPrefix(id);
  const dbPlain = Buffer.from('dump'), dbCipher = Buffer.from(await new Response(await encrypt(recipient, bytesStream(dbPlain))).arrayBuffer());
  const digest = (buf: Buffer) => ({ sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length });
  const gymId = randomUUID(), uploadKey = gymId + '/file.txt';
  const uploads: Manifest['uploads'] = options.withUpload ? [{
    gymId, key: uploadKey,
    blob: blobName(blobKey, gymId, uploadKey, '00'.repeat(32), recipient),
    recipient, contentType: 'text/plain', createdAt: '2026-11-23T12:00:00.000Z',
    plaintext: { sha256: '00'.repeat(32), size: 4 }, encrypted: { sha256: '00'.repeat(32), size: 4 },
  }] : [];
  const manifest: Manifest = {
    version: 1, id, kind: 'manual', startedAt: '2026-11-23T12:00:00.000Z',
    database: { encrypted: digest(dbCipher), plaintext: digest(dbPlain) },
    recovery: { appEncryptionKey: '01'.repeat(32), blobKey: blobKey.toString('hex') },
    uploads,
  };
  const manifestCipher = Buffer.from(await new Response(await encrypt(recipient, bytesStream(JSON.stringify(manifest)))).arrayBuffer());
  await store.putObject(prefix + 'manifest.age', bytesStream(manifestCipher));
  await store.putObject(prefix + 'references.json', bytesStream(signReferences({
    version: 1, id, kind: 'manual', startedAt: manifest.startedAt, recipient,
    database: manifest.database.encrypted, manifest: digest(manifestCipher),
    uploads: publicReferences(uploads, blobKey),
  }, blobKey)));
  if (options.withDatabase) await store.putObject(prefix + 'database.age', bytesStream(dbCipher));
  return { id, identity, prefix };
}

describe('restoreFailureClass', () => {
  it('names rejected credentials', () => {
    for (const code of ['SignatureDoesNotMatch', 'InvalidAccessKeyId']) {
      expect(restoreFailureClass(s3Error({ name: code, Code: code, $metadata: { httpStatusCode: 403 } }))).toBe('credentials_rejected');
    }
  });
  it('names a refused access apart from rejected credentials', () => {
    expect(restoreFailureClass(s3Error({ name: 'AccessDenied', Code: 'AccessDenied', $metadata: { httpStatusCode: 403 } }))).toBe('access_denied');
    expect(restoreFailureClass(s3Error({ name: 'Error', $metadata: { httpStatusCode: 401 } }))).toBe('access_denied');
  });
  it('names a missing bucket', () => {
    expect(restoreFailureClass({ name: 'NoSuchBucket', Code: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } })).toBe('bucket_missing');
  });
  it('names a missing snapshot', () => {
    expect(restoreFailureClass({ name: 'NoSuchKey', Code: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })).toBe('snapshot_missing');
    expect(restoreFailureClass({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })).toBe('snapshot_missing');
    expect(restoreFailureClass(new RestoreFailure(restoreTexts.snapshotMissing))).toBe('snapshot_missing');
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
  it('names the endpoint for a body stream reset while reading references.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restore-references-'));
    try {
      const store = new FakeBackupObjectStore();
      const { id, identity, prefix } = await seedSnapshot(store);
      const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      const getObject = store.getObject.bind(store);
      vi.spyOn(store, 'getObject').mockImplementation(async (key) =>
        key === prefix + 'references.json' ? new ReadableStream({ pull(controller) { controller.error(reset); } }) : await getObject(key));
      const database = { locked: <T>(action: () => Promise<T>) => action() } as unknown as PostgresMaintenance;
      const service = new RestoreService({ database, store, clock: new TestClock('2026-11-23T12:00:00Z'), appEncryptionKey: Buffer.alloc(32, 1),
        stagingDirectory: join(root, 'staging'), uploadsDirectory: join(root, 'uploads'), gate: new RestoreGate(join(root, 'data')) });
      const error: unknown = await service.restore(id, identity).then(() => null, (failure: unknown) => failure);
      expect(error).toBe(reset);
      expect(restoreFailureClass(error)).toBe('endpoint_unreachable');
      expect((await readdir(join(root, 'staging'))).filter((name) => name.startsWith('restore-'))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('distinguishes a missing manifest from a missing database or upload blob', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restore-missing-'));
    try {
      const database = { locked: <T>(action: () => Promise<T>) => action() } as unknown as PostgresMaintenance;
      const run = async (store: FakeBackupObjectStore, id: string, identity: string) => {
        const service = new RestoreService({ database, store, clock: new TestClock('2026-11-23T12:00:00Z'), appEncryptionKey: Buffer.alloc(32, 1),
          stagingDirectory: join(root, 'staging'), uploadsDirectory: join(root, 'uploads'), gate: new RestoreGate(join(root, 'data')) });
        return await service.restore(id, identity).then(() => null, (failure: unknown) => failure);
      };
      const missingManifest = await run(new FakeBackupObjectStore(), randomUUID(), await generateIdentity());
      expect(missingManifest).toBeInstanceOf(RestoreFailure);
      expect((missingManifest as Error).message).toBe(restoreTexts.snapshotMissing);
      expect(restoreFailureClass(missingManifest)).toBe('snapshot_missing');

      const noDatabaseStore = new FakeBackupObjectStore();
      const noDb = await seedSnapshot(noDatabaseStore);
      const missingDatabase = await run(noDatabaseStore, noDb.id, noDb.identity);
      expect(missingDatabase).toBeInstanceOf(RestoreFailure);
      expect((missingDatabase as Error).message).toBe(restoreTexts.objectMissing);
      expect(restoreFailureClass(missingDatabase)).toBe('damaged');

      const noBlobStore = new FakeBackupObjectStore();
      const noBlob = await seedSnapshot(noBlobStore, { withDatabase: true, withUpload: true });
      const missingBlob = await run(noBlobStore, noBlob.id, noBlob.identity);
      expect(missingBlob).toBeInstanceOf(RestoreFailure);
      expect((missingBlob as Error).message).toBe(restoreTexts.objectMissing);
      expect(restoreFailureClass(missingBlob)).toBe('damaged');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('names the private key problems', () => {
    expect(restoreFailureClass(new AgeKeyMismatchError(new Error('no match')))).toBe('wrong_key');
    expect(restoreFailureClass(new Error('Invalid age private key'))).toBe('invalid_key');
  });
  it('names a damaged snapshot and contents this version cannot read', () => {
    expect(restoreFailureClass(new RestoreFailure(restoreTexts.objectMissing))).toBe('damaged');
    expect(restoreFailureClass(new RestoreFailure(restoreTexts.damaged))).toBe('damaged');
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
