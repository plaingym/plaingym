// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, assert, beforeAll, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line no-restricted-imports -- The maintenance entry reads backups through the real app-role pool; no raw queries.
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { backupRuns, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { BackupService } from '../areas/health/backups.js';
import { PostgresMaintenance } from '../areas/health/backups.database.js';
import { bytesStream } from '../areas/health/backups.files.js';
import { snapshotPrefix } from '../areas/health/backups.format.js';
import * as configuration from '../areas/health/restore.config.js';
import { generateIdentity, identityToRecipient } from '../infra/age/index.js';
import { FakeBackupObjectStore, type BackupObjectStore } from '../infra/storage/index.js';
import { BackupsNotSetUpError, maintenanceCommand } from './restore.js';

// restore.ts defers these six modules behind import() so the snapshot command never loads restore code.
// A factory that throws makes a later static import fail at module load and names the module.
const restoreImports = vi.hoisted(() => {
  const loaded: string[] = [];
  const fail = (name: string): never => { loaded.push(name); throw new Error('snapshot path loaded ' + name); };
  return { loaded, fail };
});
vi.mock('../areas/health/restore.gate.js', () => restoreImports.fail('restore.gate'));
vi.mock('../areas/health/restore.js', () => restoreImports.fail('areas/health/restore'));
vi.mock('./restore.rotate-key.js', () => restoreImports.fail('restore.rotate-key'));
vi.mock('./restore.reason.js', () => restoreImports.fail('restore.reason'));
vi.mock('./restore.failure.js', () => restoreImports.fail('restore.failure'));
vi.mock('./restore.files.js', () => restoreImports.fail('restore.files'));

const database = useTestDatabase(), factory = createFactories(database);
const gymId = uuidv7();
let directory: string;
beforeAll(async () => {
  await initializeDatabase(database.appUrl);
  directory = await mkdtemp(join(tmpdir(), 'maintenance-snapshot-imports-'));
  vi.stubEnv('APP_ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubEnv('BACKUP_STAGING_DIR', join(directory, 'staging'));
  vi.stubEnv('UPLOADS_DIR', join(directory, 'uploads'));
  // Never connected by the unconfigured case, which stops before it takes a snapshot; the configured case stubs the real URL.
  vi.stubEnv('MAINTENANCE_DATABASE_URL', 'postgres://maintenance:unused@127.0.0.1:1/unused');
  await factory('gyms', gymId, { name: 'Backups set up later' });
});
afterAll(async () => { vi.unstubAllEnvs(); await closeDatabase(); await rm(directory, { recursive: true, force: true }); });

it('keeps the snapshot path free of the six restore-only modules', async () => {
  const failure = await maintenanceCommand(['snapshot', 'pre-upgrade']).then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(BackupsNotSetUpError);
  expect(restoreImports.loaded).toEqual([]);
});
it('mocks modules that exist, so a rename cannot leave the guard checking nothing', () => {
  const mocked = ['../areas/health/restore.gate.ts', '../areas/health/restore.ts', './restore.rotate-key.ts',
    './restore.reason.ts', './restore.failure.ts', './restore.files.ts'];
  expect(mocked.filter(path => !existsSync(new URL(path, import.meta.url)))).toEqual([]);
});

it('keeps a configured snapshot and its availability check free of restore-only modules', async () => {
  const recipient = await identityToRecipient(await generateIdentity());
  const store = new FakeBackupObjectStore();
  const maintenanceUrl = process.env.MAINTENANCE_DATABASE_URL;
  const destroy = vi.fn();
  // The commands use the object-store interface and only destroy the client.
  const backupConfiguration: {
    configuredBackup: (...args: Parameters<typeof configuration.configuredBackup>) => {
      client: { destroy(): void }; store: BackupObjectStore; service: BackupService;
    };
  } = configuration;
  try {
    vi.stubEnv('MAINTENANCE_DATABASE_URL', database.maintenanceUrl);
    vi.spyOn(configuration, 'loadBackupConfig').mockImplementation(async appEncryptionKey => ({
      gymId, recipient, appEncryptionKey, blobKey: Buffer.alloc(32, 8), budgetBytes: 8_000_000_000,
      destination: { bucket: 'backups', region: 'auto', accessKeyId: 'fixture', secretAccessKey: 'fixture' },
    }));
    vi.spyOn(backupConfiguration, 'configuredBackup').mockImplementation((config, database, clock, stagingDirectory) => ({
      client: { destroy },
      store,
      service: new BackupService({
        database, store, clock, stagingDirectory, recipient: config.recipient,
        appEncryptionKey: config.appEncryptionKey, blobKey: config.blobKey, budgetBytes: config.budgetBytes,
        uploads: async () => new Map(),
      }),
    }));
    vi.spyOn(PostgresMaintenance.prototype, 'dump').mockImplementation(async () => bytesStream('fixture dump'));
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await maintenanceCommand(['snapshot', 'pre-upgrade']);
    expect(restoreImports.loaded).toEqual([]);
    expect(destroy).toHaveBeenCalledTimes(1);
    const lines = output.mock.calls.map(([line]) => String(line)).join('');
    const id = /^Snapshot: ([0-9a-f-]{36})$/m.exec(lines)?.[1];
    assert(id, 'Expected the snapshot command to print its UUID');
    const prefix = snapshotPrefix(id);
    expect(await store.headObject(prefix + 'references.json')).not.toBeNull();
    const runs = await database.forSystem(tx => tx.select().from(backupRuns).where(eq(backupRuns.id, id)));
    expect(runs).toMatchObject([{ kind: 'pre_upgrade', status: 'succeeded', objectPrefix: prefix }]);

    output.mockClear();
    await maintenanceCommand(['snapshot-check', id]);
    expect(restoreImports.loaded).toEqual([]);
    expect(output).toHaveBeenCalledWith('Snapshot availability: available\n');
    expect(destroy).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks();
    vi.stubEnv('MAINTENANCE_DATABASE_URL', maintenanceUrl);
  }
});
