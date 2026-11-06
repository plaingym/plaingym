// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- The maintenance entry reads backups through the real app-role pool; no raw queries.
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { backupsConfigured } from '../areas/health/restore.config.js';
import { BackupsNotSetUpError, maintenanceCommand } from './restore.js';

const database = useTestDatabase();
let directory: string;
beforeAll(async () => {
  await initializeDatabase(database.appUrl);
  directory = await mkdtemp(join(tmpdir(), 'maintenance-fresh-'));
  vi.stubEnv('APP_ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubEnv('BACKUP_STAGING_DIR', join(directory, 'staging'));
  vi.stubEnv('UPLOADS_DIR', join(directory, 'uploads'));
  // Never connected: the command stops before it takes a snapshot.
  vi.stubEnv('MAINTENANCE_DATABASE_URL', 'postgres://maintenance:unused@127.0.0.1:1/unused');
});
afterAll(async () => { vi.unstubAllEnvs(); await closeDatabase(); await rm(directory, { recursive: true, force: true }); });

// A manual `update.sh` reaches the snapshot before setup: only the nightly path stops for a missing gym.
it('says backups are not set up before the setup wizard creates the gym', async () => {
  expect(await backupsConfigured(Buffer.alloc(32))).toBe(false);
  await expect(maintenanceCommand(['snapshot', 'pre-upgrade'])).rejects.toBeInstanceOf(BackupsNotSetUpError);
});
