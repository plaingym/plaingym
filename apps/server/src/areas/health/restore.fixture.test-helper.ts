// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { authAccount, gyms, uuidv7 } from '@plaingym/db';
import { createFactories } from '@plaingym/db/testing/factories';
import type { useTestDatabase } from '@plaingym/db/testing/database';
import { TestClock } from '../../core/clock.js';
import { encryptSecret } from '../../core/secrets.js';
import { generateIdentity, identityToRecipient } from '../../infra/age/index.js';
import { createS3Client, LocalUploads, S3BackupObjectStore } from '../../infra/storage/index.js';
import { s3Server } from '../../infra/storage/s3-server.test-helper.js';
import { BackupService } from './backups.js';
import { PostgresMaintenance } from './backups.database.js';
import type { ToolRunner } from './backups.database.js';
import { RestoreService } from './restore.js';
import { RestoreGate } from './restore.gate.js';

type Database = ReturnType<typeof useTestDatabase>;
type BackupOptions = Partial<ConstructorParameters<typeof BackupService>[0]>;
type Checkpoint = ConstructorParameters<typeof RestoreService>[0]['checkpoint'];
type Bucket = Awaited<ReturnType<typeof s3Server>>;
type StoredObject = Bucket['objects'] extends Map<string, infer T> ? T : never;
/** A stored object with its own bytes, since tests tamper with them in place. */
const copyOf = (object: StoredObject): StoredObject => ({ ...object, bytes: Buffer.from(object.bytes) });
const downloadUrl = 'https://gym.example.test/uploads';
export const dockerTools: ToolRunner = (tool, env) => ({
  command: 'docker', args: ['run', '--rm', '-i', ...(process.platform === 'linux' ? ['--network', 'host'] : []), '-e', 'PGHOST', '-e', 'PGPORT',
    '-e', 'PGDATABASE', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGCONNECT_TIMEOUT',
    'postgres:18@sha256:1267c7e692de235fda2a50dbcdbcbca4672ea6a0298576a6bd9d07cafc319b32', tool],
  env: { ...env, PGHOST: process.platform === 'linux' ? '127.0.0.1' : 'host.docker.internal' },
});

/**
 * The install snapshot and restore tests' shared setup: a source and a target database, a gym with every secret class
 * encrypted under an old app key, and a loopback S3 backup bucket. Every test gets its own directories, a fresh
 * `target/uploads` sentinel and a new clock reading.
 *
 * The databases come from the test file (`useTestDatabase()`), which is what has Vitest start a PostgreSQL for it.
 * By default each test also gets its own bucket. With `shared`, the bucket is built once and the file takes the
 * snapshots its tests share in its own `beforeAll` through `prepare`; after each test the bucket's objects return to
 * what they were after `prepare`, so tests that only read a snapshot (or tamper with its objects) skip a dump each.
 */
export function useRestoreFixture({ source, target }: { source: Database; target: Database }, options: { shared?: boolean } = {}) {
  const make = createFactories(source);
  const clock = new TestClock('2026-10-22T12:00:00Z');
  const oldKey = randomBytes(32), currentKey = randomBytes(32), blobKey = randomBytes(32);
  const gymId = uuidv7(), shared = options.shared === true;
  const state = {} as {
    identity: string; recipient: string; root: string; prepared: string | undefined;
    sourceMaintenance: PostgresMaintenance; targetMaintenance: PostgresMaintenance;
    server: Bucket; client: ReturnType<typeof createS3Client>; store: S3BackupObjectStore;
    uploads: LocalUploads; pristine: Map<string, StoredObject>;
  };
  const openBucket = async () => {
    state.server = await s3Server();
    state.client = createS3Client({ endpoint: state.server.endpoint, maxAttempts: 1,
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
    state.store = new S3BackupObjectStore({ client: state.client, bucket: 'backups', clock });
  };
  const closeBucket = async () => { state.client?.destroy(); await state.server?.close(); };
  const sourceUploads = async (root: string) => {
    const uploads = new LocalUploads({ root: join(root, 'source-uploads'), gymId, clock, signingKey: oldKey, downloadUrl });
    await uploads.put(gymId + '/photo', Buffer.from('original upload'), 'image/png');
    return uploads;
  };
  const dropPrepared = async () => {
    if (state.prepared) await rm(state.prepared, { recursive: true, force: true });
    state.prepared = undefined;
  };
  beforeAll(async () => {
    state.identity = await generateIdentity(); state.recipient = await identityToRecipient(state.identity);
    state.sourceMaintenance = new PostgresMaintenance(source.maintenanceUrl, dockerTools);
    state.targetMaintenance = new PostgresMaintenance(target.maintenanceUrl, dockerTools);
    await make('gyms', gymId, {
      stripeConfig: encryptSecret(oldKey, 'stripe_config', 'stripe-test'),
      smtpConfig: encryptSecret(oldKey, 'smtp_config', 'smtp-test'),
      s3Config: encryptSecret(oldKey, 's3_config', 's3-test'),
      qrKey: encryptSecret(oldKey, 'qr_key', 'stable-qr-secret'),
      backupBlobKey: encryptSecret(oldKey, 'backup_blob_key', blobKey.toString('hex')),
      billingEnabled: true,
    });
    await make('authAccount', gymId, {
      accessToken: encryptSecret(oldKey, 'oauth_access_token', 'access-test'),
      refreshToken: encryptSecret(oldKey, 'oauth_refresh_token', 'refresh-test'),
      idToken: encryptSecret(oldKey, 'oauth_id_token', 'id-test'),
    });
    if (!shared) return;
    await openBucket();
    state.pristine = new Map();
    state.root = state.prepared = await mkdtemp(join(tmpdir(), 'plaingym-backups-'));
    state.uploads = await sourceUploads(state.root);
  });
  beforeEach(async () => {
    await dropPrepared();
    clock.set('2026-10-22T12:00:00Z');
    state.root = await mkdtemp(join(tmpdir(), 'plaingym-backups-'));
    if (!shared) await openBucket();
    state.uploads = await sourceUploads(state.root);
    const sentinel = new LocalUploads({ root: join(state.root, 'target', 'uploads'), gymId, clock, signingKey: currentKey, downloadUrl });
    await sentinel.put(gymId + '/sentinel', Buffer.from('live upload sentinel'), 'text/plain');
  });
  afterEach(async () => {
    if (shared) {
      // Tests tamper with stored objects in place, so hand back fresh copies.
      state.server.objects.clear();
      for (const [key, object] of state.pristine) state.server.objects.set(key, copyOf(object));
      state.server.state.aborted = 0; state.server.state.failPart = 0; state.server.state.failComplete = false;
      state.server.state.failAbort = false; state.server.state.completedPartSizes.length = 0; state.server.state.requests = 0;
      state.server.uploads.clear();
    } else await closeBucket();
    if (state.root) await rm(state.root, { recursive: true, force: true });
  });
  afterAll(async () => { await dropPrepared(); if (shared) await closeBucket(); });
  return {
    source, target, make, clock, oldKey, currentKey, blobKey, gymId,
    get identity() { return state.identity; }, get recipient() { return state.recipient; },
    get root() { return state.root; }, get server() { return state.server; }, get client() { return state.client; },
    get store() { return state.store; }, get uploads() { return state.uploads; },
    get sourceMaintenance() { return state.sourceMaintenance; }, get targetMaintenance() { return state.targetMaintenance; },
    /** Shared bucket only: runs `action` (the dumps the file's tests share) before the first test. */
    async prepare<T>(action: () => Promise<T>): Promise<T> {
      try { return await action(); } finally {
        state.pristine = new Map([...state.server.objects].map(([key, object]) => [key, copyOf(object)]));
        await dropPrepared();
      }
    },
    backup(overrides: BackupOptions = {}) {
      return new BackupService({ database: state.sourceMaintenance, store: state.store, clock, recipient: state.recipient, blobKey,
        appEncryptionKey: oldKey, stagingDirectory: join(state.root, 'backup-staging'), scope: source,
        uploads: async () => new Map([[gymId, state.uploads]]), ...overrides });
    },
    restore(checkpoint?: Checkpoint) {
      return new RestoreService({ database: state.targetMaintenance, store: state.store, clock, appEncryptionKey: currentKey,
        stagingDirectory: join(state.root, 'target', 'staging'), uploadsDirectory: join(state.root, 'target', 'uploads'),
        gate: new RestoreGate(join(state.root, 'target')), ...(checkpoint ? { checkpoint } : {}) });
    },
    /** The restored install's local uploads, read with the current app key. */
    restoredUploads: () => new LocalUploads({ root: join(state.root, 'target', 'uploads'), gymId, clock, signingKey: currentKey, downloadUrl }),
    gate: () => new RestoreGate(join(state.root, 'target')),
    async secretRows() {
      return target.forSystem(async (tx) => ({
        gym: (await tx.select().from(gyms).where(eq(gyms.id, gymId)))[0]!,
        account: (await tx.select().from(authAccount))[0]!,
      }));
    },
  };
}
export type RestoreFixture = ReturnType<typeof useRestoreFixture>;
