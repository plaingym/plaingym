// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { authAccount, backupRuns, encryptedFields, gyms, uuidv7 } from '@plaingym/db';
import { createFactories } from '@plaingym/db/testing/factories';
import { cloneDatabase, useTestDatabase } from '@plaingym/db/testing/database';
// Test-only maintenance connection builds the pre-migration restore fixture.
// eslint-disable-next-line no-restricted-imports
import { openConnection } from '@plaingym/db/client';
import { TestClock } from '../../core/clock.js';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';
import { generateIdentity, identityToRecipient } from '../../infra/age/index.js';
import { createS3Client, LocalUploads, S3BackupObjectStore, S3Uploads } from '../../infra/storage/index.js';
import { s3Server } from '../../infra/storage/s3-server.test-helper.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import { registerBackupJobs } from './backups.jobs.js';
import { BackupService } from './backups.js';
import { PostgresMaintenance } from './backups.database.js';
import type { ToolRunner } from './backups.database.js';
import { RestoreService } from './restore.js';
import { RestoreGate } from './restore.gate.js';
import { inventory } from './backups.retention.js';
import { protectedName, snapshotPrefix } from './backups.format.js';

const source = useTestDatabase(), target = useTestDatabase();
const factories = createFactories(source);
const clock = new TestClock('2026-10-22T12:00:00Z');
const oldKey = randomBytes(32), currentKey = randomBytes(32), blobKey = randomBytes(32);
const gymId = uuidv7();
let identity: string, recipient: string, root: string;
let server: Awaited<ReturnType<typeof s3Server>>;
let client: ReturnType<typeof createS3Client>, store: S3BackupObjectStore, uploads: LocalUploads;
const dockerTools: ToolRunner = (tool, env) => ({
  command: 'docker', args: ['run', '--rm', '-i', ...(process.platform === 'linux' ? ['--network', 'host'] : []), '-e', 'PGHOST', '-e', 'PGPORT',
    '-e', 'PGDATABASE', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGCONNECT_TIMEOUT',
    'postgres:18@sha256:1267c7e692de235fda2a50dbcdbcbca4672ea6a0298576a6bd9d07cafc319b32', tool],
  env: { ...env, PGHOST: process.platform === 'linux' ? '127.0.0.1' : 'host.docker.internal' },
});
let sourceMaintenance: PostgresMaintenance, targetMaintenance: PostgresMaintenance;
function backup(options: Partial<ConstructorParameters<typeof BackupService>[0]> = {}) {
  return new BackupService({ database: sourceMaintenance, store, clock, recipient, blobKey,
    appEncryptionKey: oldKey, stagingDirectory: join(root, 'backup-staging'), scope: source,
    uploads: async () => new Map([[gymId, uploads]]), ...options });
}
function restore(checkpoint?: ConstructorParameters<typeof RestoreService>[0]['checkpoint']) {
  return new RestoreService({ database: targetMaintenance, store, clock, appEncryptionKey: currentKey,
    stagingDirectory: join(root, 'target', 'staging'), uploadsDirectory: join(root, 'target', 'uploads'),
    gate: new RestoreGate(join(root, 'target')), ...(checkpoint ? { checkpoint } : {}) });
}
async function secretRows() {
  return target.forSystem(async (tx) => ({
    gym: (await tx.select().from(gyms).where(eq(gyms.id, gymId)))[0]!,
    account: (await tx.select().from(authAccount))[0]!,
  }));
}
beforeAll(async () => {
  identity = await generateIdentity(); recipient = await identityToRecipient(identity);
  sourceMaintenance = new PostgresMaintenance(source.maintenanceUrl, dockerTools);
  targetMaintenance = new PostgresMaintenance(target.maintenanceUrl, dockerTools);
  const gymSecrets = {
    stripeConfig: encryptSecret(oldKey, 'stripe_config', 'stripe-test'),
    smtpConfig: encryptSecret(oldKey, 'smtp_config', 'smtp-test'),
    s3Config: encryptSecret(oldKey, 's3_config', 's3-test'),
    qrKey: encryptSecret(oldKey, 'qr_key', 'stable-qr-secret'),
    backupBlobKey: encryptSecret(oldKey, 'backup_blob_key', blobKey.toString('hex')),
  };
  await factories('gyms', gymId, { ...gymSecrets, billingEnabled: true });
  await factories('authAccount', gymId, {
    accessToken: encryptSecret(oldKey, 'oauth_access_token', 'access-test'),
    refreshToken: encryptSecret(oldKey, 'oauth_refresh_token', 'refresh-test'),
    idToken: encryptSecret(oldKey, 'oauth_id_token', 'id-test'),
  });
});
beforeEach(async () => {
  clock.set('2026-10-22T12:00:00Z');
  root = await mkdtemp(join(tmpdir(), 'plaingym-backups-'));
  server = await s3Server();
  client = createS3Client({ endpoint: server.endpoint, maxAttempts: 1,
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
  store = new S3BackupObjectStore({ client, bucket: 'backups', clock });
  uploads = new LocalUploads({ root: join(root, 'source-uploads'), gymId, clock,
    signingKey: oldKey, downloadUrl: 'https://gym.example.test/uploads' });
  await uploads.put(gymId + '/photo', Buffer.from('original upload'), 'image/png');
  const sentinel = new LocalUploads({ root: join(root, 'target', 'uploads'), gymId, clock,
    signingKey: currentKey, downloadUrl: 'https://gym.example.test/uploads' });
  await sentinel.put(gymId + '/sentinel', Buffer.from('live upload sentinel'), 'text/plain');
});
afterEach(async () => {
  client?.destroy(); await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('install snapshot and restore with real Postgres and S3', () => {

  it('deduplicates coincident system-job schedules and runs one install-wide snapshot', async () => {
    const queue = new PostgresJobs({ database: source, clock });
    const scheduler = registerBackupJobs(queue, backup(), clock);
    await Promise.all([scheduler.scheduleDue(), scheduler.scheduleDue()]);
    expect(await queue.runNext()).toBe(true);
    expect(await queue.runNext()).toBe(false);
    expect((await inventory(store, blobKey)).snapshots).toHaveLength(1);
    const paused = new PostgresJobs({ database: source, clock });
    const pausedScheduler = registerBackupJobs(paused, backup(), clock, async () => true);
    clock.advance(3_600_000);
    await pausedScheduler.scheduleDue();
    expect(await paused.runNext()).toBe(false);
  });

  it('drains an admitted worker waiting for the backup lock before replacing the database', async () => {
    const snapshot = await backup().snapshot();
    const gate = new RestoreGate(join(root, 'target'));
    const getObject = store.getObject.bind(store);
    let worker: Promise<void> | undefined, queued = false, finished = false;
    store.getObject = async (key) => {
      if (!queued && key.endsWith('manifest.age')) {
        queued = true;
        let admit!: () => void;
        const admitted = new Promise<void>((resolve) => { admit = resolve; });
        worker = gate.activity(async () => {
          admit();
          await targetMaintenance.locked(async () => { finished = true; });
        });
        await admitted;
      }
      return getObject(key);
    };
    try {
      await restore((phase) => { if (phase === 'database_restored') expect(finished).toBe(true); }).restore(snapshot.id, identity);
      await worker;
      expect(finished).toBe(true);
    } finally { store.getObject = getObject; }
  });

  it('keeps upload paths and content hashes inside the encrypted manifest', async () => {
    const snapshot = await backup().snapshot();
    const object = server.objects.get('backups/' + snapshotPrefix(snapshot.id) + 'references.json')!;
    expect(object.bytes.toString()).not.toContain(gymId);
    expect(object.bytes.toString()).not.toContain('/photo');
    expect(object.bytes.toString()).not.toContain('original upload');
    expect(object.bytes.toString()).not.toContain(createHash('sha256').update('original upload').digest('hex'));
  });

  it('captures S3-backed uploads through the same storage interface and restores them locally', async () => {
    const s3Uploads = new S3Uploads({ client, bucket: 'uploads', gymId, clock });
    await s3Uploads.put(gymId + '/s3-photo', Buffer.from('S3 source bytes'), 'image/png');
    const snapshot = await backup({ uploads: async () => new Map([[gymId, s3Uploads]]) }).snapshot();
    await restore().restore(snapshot.id, identity);
    const recovered = new LocalUploads({ root: join(root, 'target', 'uploads'), gymId, clock,
      signingKey: currentKey, downloadUrl: 'https://gym.example.test/uploads' });
    expect(await new Response(await recovered.get(gymId + '/s3-photo')).text()).toBe('S3 source bytes');
  });

  describe('into an install that keeps uploads in S3', () => {
    const bucketUploads = (bucket = 'uploads') => new S3Uploads({ client, bucket, gymId, clock });
    const storeRestore = (bucket = 'uploads', checkpoint?: ConstructorParameters<typeof RestoreService>[0]['checkpoint']) =>
      new RestoreService({ ...restore(checkpoint).options, uploadsStore: async (id) => new S3Uploads({ client, bucket, gymId: id, clock }) });
    async function s3Snapshot() {
      await bucketUploads().put(gymId + '/s3-photo', Buffer.from('S3 source bytes'), 'image/png');
      return backup({ uploads: async () => new Map([[gymId, bucketUploads()]]) }).snapshot();
    }
    it('revives files deleted after the snapshot and marks later files deleted, leaving the uploads directory alone', async () => {
      const snapshot = await s3Snapshot();
      clock.advance(60_000);
      await bucketUploads().markDeleted(gymId + '/s3-photo');
      await bucketUploads().put(gymId + '/later', Buffer.from('uploaded after the snapshot'), 'text/plain');
      await storeRestore().restore(snapshot.id, identity);
      const restored = bucketUploads();
      expect(await new Response(await restored.get(gymId + '/s3-photo')).text()).toBe('S3 source bytes');
      expect((await restored.head(gymId + '/s3-photo'))!.deletedAt).toBeUndefined();
      expect((await restored.head(gymId + '/later'))!.deletedAt).toEqual(clock.now());
      const directory = new LocalUploads({ root: join(root, 'target', 'uploads'), gymId, clock,
        signingKey: currentKey, downloadUrl: 'https://gym.example.test/uploads' });
      expect(await new Response(await directory.get(gymId + '/sentinel')).text()).toBe('live upload sentinel');
      expect(await directory.head(gymId + '/s3-photo')).toBeNull();
    });
    it('publishes every file into an empty bucket on a new server', async () => {
      const snapshot = await s3Snapshot();
      await storeRestore('uploads-new').restore(snapshot.id, identity);
      const restored = bucketUploads('uploads-new');
      expect(await restored.head(gymId + '/s3-photo')).toMatchObject({ contentType: 'image/png', createdAt: clock.now() });
      expect(await new Response(await restored.get(gymId + '/s3-photo')).text()).toBe('S3 source bytes');
    });
    it.each(['old_uploads_renamed', 'new_uploads_renamed'] as const)('resumes after interruption at %s', async (stop) => {
      const snapshot = await s3Snapshot();
      let interrupted = false;
      await expect(storeRestore('uploads-new', (phase) => { if (!interrupted && phase === stop) { interrupted = true; throw new Error('Power loss'); } })
        .restore(snapshot.id, identity)).rejects.toThrow('Power loss');
      // A restore journaled for the bucket never finishes into the directory.
      await expect(restore().resume()).rejects.toThrow('Upload storage changed');
      await storeRestore('uploads-new').resume();
      expect(await new Response(await bucketUploads('uploads-new').get(gymId + '/s3-photo')).text()).toBe('S3 source bytes');
      expect(await new RestoreGate(join(root, 'target')).isClosed()).toBe(false);
    });
  });

  it('does not reuse blobs encrypted to a previous recipient after public-key rotation', async () => {
    const first = await backup().snapshot();
    const newIdentity = await generateIdentity(), newRecipient = await identityToRecipient(newIdentity);
    const second = await backup({ recipient: newRecipient }).snapshot();
    expect(second.uploads[0]!.blob).not.toBe(first.uploads[0]!.blob);
    await restore().restore(second.id, newIdentity);
  });

  it('restores every registered secret with a new app key and preserves the QR key, uploads, and forced RLS', async () => {
    const snapshot = await backup().snapshot();
    await restore().restore(snapshot.id, identity);
    const { gym, account } = await secretRows();
    expect(gym.billingEnabled).toBe(false);
    const values: Record<string, string | null> = {
      stripe_config: gym.stripeConfig, smtp_config: gym.smtpConfig, s3_config: gym.s3Config,
      qr_key: gym.qrKey, backup_blob_key: gym.backupBlobKey,
      oauth_access_token: account.accessToken, oauth_refresh_token: account.refreshToken, oauth_id_token: account.idToken,
    };
    for (const field of encryptedFields) {
      expect(decryptSecret(currentKey, field.secretClass, values[field.secretClass]!)).toBe(
        field.secretClass === 'backup_blob_key' ? blobKey.toString('hex') :
          field.secretClass === 'qr_key' ? 'stable-qr-secret' :
            field.secretClass.replace('_config', '').replace('oauth_', '').replace('_token', '') + '-test');
      expect(() => decryptSecret(oldKey, field.secretClass, values[field.secretClass]!)).toThrow();
    }
    const restored = new LocalUploads({ root: join(root, 'target', 'uploads'), gymId, clock,
      signingKey: currentKey, downloadUrl: 'https://gym.example.test/uploads' });
    expect(await new Response(await restored.get(gymId + '/photo')).text()).toBe('original upload');
    expect(await restored.get(gymId + '/sentinel')).toBeNull();
    expect(await new RestoreGate(join(root, 'target')).isClosed()).toBe(false);
    // migrate() includes the exact catalog assertion for FORCE RLS, privileges, and table inventory.
    await targetMaintenance.migrate();
    const history = await source.forSystem((tx) => tx.select().from(backupRuns).where(eq(backupRuns.id, snapshot.id)));
    expect(history[0]?.status).toBe('succeeded');
  });

  it.each(['wrong-key', 'truncated-dump', 'corrupt-blob', 'reordered-dump', 'missing-reference', 'substituted-manifest'])(
    'rejects %s before changing live rows or uploads', async (mode) => {
      const snapshot = await backup().snapshot();
      const prefix = 'backups/' + snapshotPrefix(snapshot.id);
      if (mode === 'truncated-dump' || mode === 'reordered-dump') {
        const object = server.objects.get(prefix + 'database.age')!;
        const bytes = Buffer.from(object.bytes);
        if (mode === 'truncated-dump') object.bytes = bytes.subarray(0, -1);
        else { const offset = Math.floor(bytes.length / 2); bytes.copyWithin(offset, offset + 32); object.bytes = bytes; }
      } else if (mode === 'corrupt-blob') {
        const object = server.objects.get('backups/' + snapshot.uploads[0]!.blob)!;
        object.bytes = Buffer.from(object.bytes); object.bytes[object.bytes.length - 1]! ^= 1;
      } else if (mode === 'missing-reference') server.objects.delete(prefix + 'references.json');
      else if (mode === 'substituted-manifest') {
        const second = await backup().snapshot();
        server.objects.set(prefix + 'manifest.age', server.objects.get('backups/' + snapshotPrefix(second.id) + 'manifest.age')!);
      }
      const before = await target.forSystem((tx) => tx.select({ id: gyms.id, secret: gyms.qrKey }).from(gyms));
      await expect(restore().restore(snapshot.id, mode === 'wrong-key' ? await generateIdentity() : identity)).rejects.toThrow();
      expect(await target.forSystem((tx) => tx.select({ id: gyms.id, secret: gyms.qrKey }).from(gyms))).toEqual(before);
      const sentinel = new LocalUploads({ root: join(root, 'target', 'uploads'), gymId, clock,
        signingKey: currentKey, downloadUrl: 'https://gym.example.test/uploads' });
      expect(await new Response(await sentinel.get(gymId + '/sentinel')).text()).toBe('live upload sentinel');
      expect(await new RestoreGate(join(root, 'target')).isClosed()).toBe(false);
    });

  it.each(['database_restored', 'secret_field', 'rekeyed', 'old_uploads_renamed', 'new_uploads_renamed'] as const)(
    'resumes after interruption at %s', async (stop) => {
      const snapshot = await backup().snapshot();
      let interrupted = false;
      const service = restore((phase) => { if (!interrupted && phase === stop) { interrupted = true; throw new Error('Power loss'); } });
      await expect(service.restore(snapshot.id, identity)).rejects.toThrow('Power loss');
      expect(await new RestoreGate(join(root, 'target')).isClosed()).toBe(true);
      await restore().resume();
      const { gym } = await secretRows();
      expect(decryptSecret(currentKey, 'qr_key', gym.qrKey!)).toBe('stable-qr-secret');
      expect(gym.billingEnabled).toBe(false);
      await restore().resume(); // Complete journals are harmless on every subsequent boot.
      expect(await new RestoreGate(join(root, 'target')).isClosed()).toBe(false);
    });

  it('reuses immutable upload blobs and protects them across retention and tombstone sweeping', async () => {
    const first = await backup().snapshot('hourly');
    clock.advance(3_600_000);
    const second = await backup().snapshot('hourly');
    expect(first.uploads[0]!.blob).toBe(second.uploads[0]!.blob);
    expect(await store.listObjects('blobs/')).toHaveLength(1);
    await uploads.markDeleted(gymId + '/photo');
    clock.advance(3_600_000);
    const retention = await backup().prune();
    const retainedObjects = [...await store.listObjects('snapshots/'), ...await store.listObjects('blobs/')];
    expect(retention.retainedBytes).toBe(retainedObjects.reduce((total, object) => total + object.size, 0));
    expect(await uploads.get(gymId + '/photo')).not.toBeNull();
    expect(await inventory(store, blobKey)).toMatchObject({ snapshots: expect.any(Array) });
  });

  it.each(['missing', 'tampered'])('halts pruning on %s references without deleting any upload blob', async (mode) => {
    const snapshot = await backup().snapshot();
    const key = 'backups/' + snapshotPrefix(snapshot.id) + 'references.json';
    if (mode === 'missing') server.objects.delete(key);
    else {
      const object = server.objects.get(key)!; object.bytes = Buffer.from(object.bytes.toString().replace('"mac":"', '"mac":"f'));
    }
    await uploads.markDeleted(gymId + '/photo');
    clock.advance(1000);
    const objectsBefore = [...server.objects.keys()].sort();
    await expect(backup().prune()).rejects.toThrow();
    expect([...server.objects.keys()].sort()).toEqual(objectsBefore);
    expect(await uploads.get(gymId + '/photo')).not.toBeNull();
  });

  it('keeps a file deleted while the dump is running in that snapshot', async () => {
    const original = sourceMaintenance.dump.bind(sourceMaintenance);
    const wrapped = new PostgresMaintenance(source.maintenanceUrl, dockerTools);
    wrapped.dump = async () => {
      clock.advance(1); await uploads.markDeleted(gymId + '/photo');
      return original();
    };
    const snapshot = await backup({ database: wrapped }).snapshot();
    expect(snapshot.uploads.map((u) => u.protectedHash)).toContain(protectedName(blobKey, gymId + '/photo'));
    await restore().restore(snapshot.id, identity);
  });

  it('retries aborted multipart uploads and records a failure without publishing an incomplete snapshot', async () => {
    server.state.failPart = 1;
    await expect(backup().snapshot()).rejects.toThrow('Snapshot failed');
    expect(server.state.aborted).toBe(3);
    expect(server.uploads.size).toBe(0);
    expect(await store.listObjects('snapshots/')).toHaveLength(0);
  });

  it('rejects a budget that cannot reserve space without publishing a snapshot', async () => {
    await expect(backup({ budgetBytes: 1 }).snapshot()).rejects.toThrow();
    expect(await store.listObjects('snapshots/')).toHaveLength(0);
  });

  it('migrates a pre-schema snapshot forward before reopening the app', async () => {
    const old = await cloneDatabase(inject('testDatabase'));
    try {
      const connection = openConnection(old.maintenanceUrl, 1);
      try {
        await connection.sql.begin(async (tx) => {
          await tx`drop schema public cascade`;
          await tx`drop schema drizzle cascade`;
          await tx`create schema public authorization maintenance`;
          await tx`revoke all on schema public from public`;
          await tx`grant usage on schema public to app`;
          await tx`alter default privileges for role maintenance in schema public grant select, insert, update, delete on tables to app`;
        });
      } finally { await connection.close(); }
      const oldMaintenance = new PostgresMaintenance(old.maintenanceUrl, dockerTools);
      const snapshot = await backup({ database: oldMaintenance }).snapshot();
      await restore().restore(snapshot.id, identity);
      await targetMaintenance.migrate();
      expect(await target.forSystem((tx) => tx.select().from(gyms))).toHaveLength(0);
    } finally { await old.cleanup(); }
  });
});
