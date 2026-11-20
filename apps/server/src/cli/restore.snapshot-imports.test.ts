// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- The maintenance entry reads backups through the real app-role pool; no raw queries.
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
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
let directory: string;
beforeAll(async () => {
  await initializeDatabase(database.appUrl);
  directory = await mkdtemp(join(tmpdir(), 'maintenance-snapshot-imports-'));
  vi.stubEnv('APP_ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubEnv('BACKUP_STAGING_DIR', join(directory, 'staging'));
  vi.stubEnv('UPLOADS_DIR', join(directory, 'uploads'));
  // Never connected: the command stops before it takes a snapshot.
  vi.stubEnv('MAINTENANCE_DATABASE_URL', 'postgres://maintenance:unused@127.0.0.1:1/unused');
  await factory('gyms', uuidv7(), { name: 'Backups set up later' });
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
