// SPDX-License-Identifier: AGPL-3.0-only
// This maintenance entry is bundled separately and never starts an HTTP listener or job worker.
// eslint-disable-next-line no-restricted-imports
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { maintenanceCommand } from './restore.js';

const args = process.argv.slice(2);
try {
  if (args[0] === 'snapshot') {
    if (!process.env.DATABASE_URL) throw new Error('Missing application database URL');
    await initializeDatabase(process.env.DATABASE_URL);
  }
  await maintenanceCommand(args);
} catch {
  console.error('Maintenance command failed; check configuration and restore state');
  process.exitCode = 1;
} finally { await closeDatabase(); }
