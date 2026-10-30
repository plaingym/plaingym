// SPDX-License-Identifier: AGPL-3.0-only
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, inject } from 'vitest';
import { openConnection, withMigrationConnection } from '../client.js';
import { applySecurity } from '../security/apply.js';
import { cloneDatabase, preparePublicSchema, type TestDatabaseConfig } from './database.js';

export interface UpgradeTestOptions {
  /** Run the reviewed security step at the starting migration, as every installed release did after migrating. */
  readonly applySecurity?: boolean;
}

/** Create an empty disposable database and migrate through the named journal tag, inclusively. */
export async function createUpgradeTestDatabase(config: TestDatabaseConfig, tag: string, options: UpgradeTestOptions = {}) {
  const source = fileURLToPath(new URL('../migrations/', import.meta.url));
  const journal = JSON.parse(await readFile(join(source, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const index = journal.entries.findIndex(entry => entry.tag === tag);
  if (index === -1) throw new Error(`Unknown migration tag: ${tag}`);
  const entries = journal.entries.slice(0, index + 1);
  const folder = await mkdtemp(join(tmpdir(), 'plaingym-upgrade-'));
  try {
    await mkdir(join(folder, 'meta'));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    await Promise.all(entries.map(entry => copyFile(join(source, entry.tag + '.sql'), join(folder, entry.tag + '.sql'))));
    // The regular migrated template contains later objects; template0 gives this test a clean schema.
    const database = await cloneDatabase({ ...config, template: 'template0' });
    try {
      const maintenance = openConnection(database.maintenanceUrl, 1);
      try {
        await preparePublicSchema(maintenance.sql);
      } finally { await maintenance.close(); }
      // Use the production migration runner and lock. Current catalog checks run after the full upgrade. The
      // security step is the current one: it must accept every starting schema an upgrade test uses.
      await withMigrationConnection(database.maintenanceUrl, folder, async ({ sql }) => {
        if (options.applySecurity) await applySecurity(sql);
      });
      return database;
    } catch (error) {
      await database.cleanup();
      throw error;
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
}

/** Call once at module scope; seed with historical SQL, then upgrade with migrateDatabase. */
export function useUpgradeTestDatabase(tag: string, options: UpgradeTestOptions = {}) {
  let database: Awaited<ReturnType<typeof createUpgradeTestDatabase>>;
  beforeAll(async () => { database = await createUpgradeTestDatabase(inject('testDatabase'), tag, options); });
  afterAll(async () => { await database?.cleanup(); });
  return {
    get maintenanceUrl() { return database.maintenanceUrl; },
    /** The app role, as the running app connects; raw SQL here seeds data under row-level security. */
    get appUrl() { return database.appUrl; },
    forGym: ((gymId, fn) => database.forGym(gymId, fn)) as typeof database.forGym,
  };
}
