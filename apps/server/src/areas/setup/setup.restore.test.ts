// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError } from '@plaingym/shared';
import type { SetupRestoreRequest } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { createApp } from '../../core/app.js';
import { createS3Client, S3BackupObjectStore } from '../../infra/storage/index.js';
import { s3Server } from '../../infra/storage/s3-server.test-helper.js';
import { generateIdentity, identityToRecipient } from '../../infra/age/index.js';
import { BackupService } from '../health/backups.js';
import { PostgresMaintenance, type ToolRunner } from '../health/backups.database.js';
import { RestoreService } from '../health/restore.js';
import { RestoreGate } from '../health/restore.gate.js';
import { atomicJson } from '../health/backups.files.js';
import { createSetupService } from './setup.js';
import { createSetupRoutes } from './setup.routes.js';
import { createSetupRestore, snapshotId } from './setup.restore.js';

const source = useTestDatabase(), target = useTestDatabase(), reservations = useTestDatabase(), factory = createFactories(source);
const clock = new TestClock('2026-10-22T12:00:00Z'), key = Buffer.alloc(32, 7), newKey = Buffer.alloc(32, 8), gymId = uuidv7();
const tools: ToolRunner = (tool, env) => ({ command: 'docker', args: ['run', '--rm', '-i', ...(process.platform === 'linux' ? ['--network', 'host'] : []), '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGDATABASE', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGCONNECT_TIMEOUT',
  'postgres:18@sha256:1267c7e692de235fda2a50dbcdbcbca4672ea6a0298576a6bd9d07cafc319b32', tool], env: { ...env, PGHOST: process.platform === 'linux' ? '127.0.0.1' : 'host.docker.internal' } });
let root: string;
// Surface the coordinator's failure message instead of only the status.
const outcome = async (pending: Promise<{ status: string } & { message?: string }>) => {
  const result = await pending;
  return result.status === 'failed' ? 'failed: ' + (result.message ?? 'no message') : result.status;
};
let server: Awaited<ReturnType<typeof s3Server>>;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'setup-restore-')); server = await s3Server(); });
afterAll(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
describe('setup restore coordinator', () => {
  it('reserves first boot across service instances and releases it after verification failure', async () => {
    const options = { key, origin: 'http://gym.localhost', scope: reservations.forGym, system: reservations.forSystem, clock };
    const service = createSetupService(options), peer = createSetupService(options);
    const reservation = await service.reserveRestore();
    await expect(peer.reserveRestore()).rejects.toMatchObject({ code: 'not_found' });
    await expect(peer.owner({ name: 'Other owner', email: 'other@example.org', password: 'other-password-123' })).rejects.toMatchObject({ code: 'not_found' });
    await reservation.release();
    expect(await service.status()).toMatchObject({ currentStep: 0 });
    const coordinator = createSetupRestore({ assertEmpty: () => service.assertEmpty(), claim: (token) => service.reserveRestore(token), restore: async () => { throw new Error('Verification failed'); } });
    const job = await coordinator.start({ choice: 'restore', source: { endpoint: 'https://s3.example.org', region: 'auto', bucket: 'backups', accessKeyId: 'access', secretAccessKey: 'secret' }, snapshotPrefix: uuidv7(), privateKey: await generateIdentity() });
    await expect.poll(async () => (await coordinator.status(job.jobId)).status).toBe('failed');
    await expect.poll(async () => (await service.status()).currentStep).toBe(0);
    expect(await reservations.forSystem((tx) => tx.select().from(gyms))).toHaveLength(0);
    await service.reserveRestore();
    await reservations.forSystem(async (tx) => {
      const [row] = await tx.select().from(gyms);
      const settings = row!.settings as { setupRestoreLease: { token: string } };
      await tx.update(gyms).set({ settings: { ...settings, setupRestoreLease: { token: settings.setupRestoreLease.token, pid: 2147483647, started: null } } }).where(eq(gyms.id, row!.id));
    });
    expect(await peer.status()).toMatchObject({ currentStep: 0 });
    expect(await reservations.forSystem((tx) => tx.select().from(gyms))).toHaveLength(0);
  });
  it('restores a real snapshot without taking an activity lease and gates database work before tenant resolution', async () => {
    await factory('gyms', gymId, { name: 'Restored academy', billingEnabled: true });
    const identity = await generateIdentity(), recipient = await identityToRecipient(identity);
    const client = createS3Client({ endpoint: server.endpoint, maxAttempts: 1, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
    try {
      const store = new S3BackupObjectStore({ client, bucket: 'backups', clock });
      const snapshot = await new BackupService({ database: new PostgresMaintenance(source.maintenanceUrl, tools), store, clock, recipient, blobKey: Buffer.alloc(32, 9),
        appEncryptionKey: key, stagingDirectory: join(root, 'source'), scope: source, uploads: async () => new Map() }).snapshot();
      const gate = new RestoreGate(join(root, 'target'));
      const service = createSetupService({ key: newKey, origin: 'http://gym.localhost', scope: target.forGym, system: target.forSystem, clock });
      let blockedProbe: Promise<Response> | undefined;
      const restore = createSetupRestore({ clock, assertEmpty: () => service.assertEmpty(), claim: (token) => service.reserveRestore(token), onRestored: () => service.markRestored(), gate, journal: join(root, 'target', 'setup-restore.json'),
        restore: (input) => new RestoreService({ database: new PostgresMaintenance(target.maintenanceUrl, tools), store, clock,
          appEncryptionKey: newKey, stagingDirectory: join(root, 'target', 'staging'), uploadsDirectory: join(root, 'target', 'uploads'), gate,
          checkpoint: (phase) => { if (phase === 'verified') blockedProbe = Promise.resolve(app.request('http://gym.localhost/api/settings')); },
        }).restore(snapshotId(input.snapshotPrefix), input.privateKey),
      });
      const tenancy = vi.fn(async () => { throw new Error('Tenant lookup must be gated'); });
      const setupToken = 'private-restore-token-at-least-32-characters';
      const app = createApp({ clock, setupToken, installOrigin: 'http://gym.localhost', contributions: { routes: createSetupRoutes(() => service, () => restore) },
        resolveGym: tenancy, session: async (_c, next) => { await next(); }, authorize: () => async (_c, next) => { await next(); }, restoreGate: gate.middleware() });
      const input: SetupRestoreRequest = { choice: 'restore', source: { endpoint: server.endpoint, region: 'auto', bucket: 'backups', accessKeyId: 'fixture', secretAccessKey: 'private-fixture' },
        snapshotPrefix: 'snapshots/' + snapshot.id + '/', privateKey: identity };
      const result = await app.request('http://gym.localhost/api/setup/restore', { method: 'POST', headers: { origin: 'http://gym.localhost', 'content-type': 'application/json', 'x-setup-token': setupToken }, body: JSON.stringify(input) });
      expect(result.status).toBe(200);
      const jobId = (await result.json() as { data: { jobId: string } }).data.jobId;
      await expect.poll(() => outcome(restore.status(jobId)), { timeout: 25_000 }).toBe('restored');
      expect((await blockedProbe)!.status).toBe(503); expect(tenancy).not.toHaveBeenCalled();
      const status = await app.request('http://gym.localhost/api/setup/restore/' + jobId, { headers: { 'x-setup-token': setupToken } });
      expect(await status.json()).toMatchObject({ data: { status: 'restored', billingEnabled: false, next: 'login' } });
      expect((await target.forSystem((tx) => tx.select().from(gyms)))[0]).toMatchObject({ name: 'Restored academy', billingEnabled: false });
      const journal = await readFile(join(root, 'target', 'setup-restore.json'), 'utf8');
      expect(journal).not.toContain(identity); expect(journal).not.toContain('private-fixture');
      const resumed = createSetupRestore({ gate, journal: join(root, 'target', 'setup-restore.json'), assertEmpty: async () => { throw new Error('No DB read for restore polling'); }, restore: async () => {} });
      expect(await resumed.status(jobId)).toMatchObject({ status: 'restored' });
      await expect(restore.start(input)).rejects.toMatchObject({ code: 'not_found' });
      await expect(service.status()).rejects.toMatchObject({ code: 'not_found' });
    } finally { client.destroy(); }
  });
  it('sanitizes failures, rejects a second running restore and hides unknown jobs', async () => {
    let fail!: (error: Error) => void;
    const coordinator = createSetupRestore({ assertEmpty: async () => {}, restore: () => new Promise((_resolve, reject) => { fail = reject; }) });
    const input: SetupRestoreRequest = { choice: 'restore', source: { endpoint: 'https://s3.example.org', region: 'auto', bucket: 'backups', accessKeyId: 'access', secretAccessKey: 'secret' }, snapshotPrefix: uuidv7(), privateKey: await generateIdentity() };
    const job = await coordinator.start(input);
    await expect(coordinator.start(input)).rejects.toMatchObject({ code: 'conflict' });
    fail(new Error('secret credentials from a provider'));
    await expect.poll(async () => (await coordinator.status(job.jobId)).status).toBe('failed');
    expect(JSON.stringify(await coordinator.status(job.jobId))).not.toContain('credentials');
    await expect(coordinator.status(uuidv7())).rejects.toBeInstanceOf(AppError);
    expect(() => snapshotId('../anything')).toThrow();
  });
  it('recognizes a verified restore completed by maintenance after a restart', async () => {
    const journal = join(root, 'restart', 'setup-restore.json'), gate = new RestoreGate(join(root, 'restart'));
    const input: SetupRestoreRequest = { choice: 'restore', source: { endpoint: 'https://s3.example.org', region: 'auto', bucket: 'backups', accessKeyId: 'access', secretAccessKey: 'secret' }, snapshotPrefix: uuidv7(), privateKey: await generateIdentity() };
    const coordinator = createSetupRestore({ journal, assertEmpty: async () => {}, restore: async () => { throw new Error('Power loss'); } });
    const job = await coordinator.start(input);
    await expect.poll(async () => (await coordinator.status(job.jobId)).status).toBe('failed');
    await atomicJson(gate.statePath, { id: input.snapshotPrefix, phase: 'complete' });
    const onRestored = vi.fn(async () => {});
    const restarted = createSetupRestore({ journal, gate, onRestored, assertEmpty: async () => { throw new Error('No DB query'); }, restore: async () => {} });
    expect(await restarted.status(job.jobId)).toMatchObject({ status: 'restored', billingEnabled: false });
    expect(onRestored).toHaveBeenCalledOnce();
  });
  it('keeps a running process\'s reservation when another process polls its journal', async () => {
    const journal = join(root, 'peer', 'setup-restore.json'), gate = new RestoreGate(join(root, 'peer'));
    let finish!: () => void;
    const coordinator = createSetupRestore({ journal, gate, assertEmpty: async () => {}, restore: () => new Promise<void>((resolve) => { finish = resolve; }) });
    const input: SetupRestoreRequest = { choice: 'restore', source: { endpoint: 'https://s3.example.org', region: 'auto', bucket: 'backups', accessKeyId: 'access', secretAccessKey: 'secret' }, snapshotPrefix: uuidv7(), privateKey: await generateIdentity() };
    const job = await coordinator.start(input), onInterrupted = vi.fn(async () => {});
    const peer = createSetupRestore({ journal, gate, onInterrupted, assertEmpty: async () => {}, restore: async () => {} });
    expect(await peer.status(job.jobId)).toMatchObject({ status: 'running' });
    expect(onInterrupted).not.toHaveBeenCalled();
    finish();
    await expect.poll(() => outcome(coordinator.status(job.jobId))).toBe('restored');
  });
});
