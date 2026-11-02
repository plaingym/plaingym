// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- The maintenance entry reads backups through the real app-role pool; no raw queries.
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { setLogSink } from '../core/log.js';
import { BackupsNotSetUpError, maintenanceCommand } from './restore.js';
import { reportMaintenanceFailure } from './restore.failure.js';

const database = useTestDatabase(), factory = createFactories(database);
let directory: string;
beforeAll(async () => {
  await initializeDatabase(database.appUrl);
  directory = await mkdtemp(join(tmpdir(), 'maintenance-snapshot-'));
  vi.stubEnv('APP_ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubEnv('BACKUP_STAGING_DIR', join(directory, 'staging'));
  vi.stubEnv('UPLOADS_DIR', join(directory, 'uploads'));
  // Never connected: the command stops before it takes a snapshot.
  vi.stubEnv('MAINTENANCE_DATABASE_URL', 'postgres://maintenance:unused@127.0.0.1:1/unused');
  await factory('gyms', uuidv7(), { name: 'Backups set up later' });
});
afterAll(async () => { vi.unstubAllEnvs(); await closeDatabase(); await rm(directory, { recursive: true, force: true }); });

it('tells the person running an update to set up backups in Settings → Email, payments and backups when none are configured', async () => {
  const failure = await maintenanceCommand(['snapshot', 'pre-upgrade']).then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(BackupsNotSetUpError);
  const lines: string[] = [], messages: string[] = [], previous = setLogSink((line) => lines.push(line));
  try { reportMaintenanceFailure(['snapshot', 'pre-upgrade'], failure, (line) => messages.push(line)); } finally { setLogSink(previous); }
  expect(messages).toEqual(['Backups are not set up: set them up in Settings → Email, payments and backups, then run the update again']);
  expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'cli.maintenance_failed', command: 'snapshot', error: { name: 'BackupsNotSetUpError' } });
});
it('keeps the generic line for every other failure', () => {
  const messages: string[] = [], previous = setLogSink(() => undefined);
  try { reportMaintenanceFailure(['snapshot'], new Error('Backup destination and public key are not configured'), (line) => messages.push(line)); }
  finally { setLogSink(previous); }
  expect(messages).toEqual(['Maintenance command failed; check configuration and restore state']);
});
