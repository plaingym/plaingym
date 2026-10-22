// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url';
import { withMigrationConnection } from './client.js';
import { applySecurity } from './security/apply.js';
import { assertCatalog } from './security/catalog.js';
export async function migrateDatabase(maintenanceUrl: string) {
  const folder = fileURLToPath(new URL('./migrations/', import.meta.url));
  await withMigrationConnection(maintenanceUrl, folder, async ({ sql }) => {
    await applySecurity(sql);
    await assertCatalog(sql);
  });
}
