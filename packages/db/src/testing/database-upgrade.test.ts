// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, inject, it } from 'vitest';
import { openConnection } from '../client.js';
import { createUpgradeTestDatabase, useUpgradeTestDatabase } from './database-upgrade.js';

const tag = '0002_rank_colors';
const database = useUpgradeTestDatabase(tag);

it('stops at the requested migration inclusively and retains its real journal hashes and timestamps', async () => {
  const source = new URL('../migrations/', import.meta.url);
  const journal = JSON.parse(await readFile(new URL('meta/_journal.json', source), 'utf8')) as {
    entries: { tag: string; when: number }[];
  };
  const entries = journal.entries.slice(0, journal.entries.findIndex(entry => entry.tag === tag) + 1);
  const expected = await Promise.all(entries.map(async entry => ({
    hash: createHash('sha256').update(await readFile(new URL(entry.tag + '.sql', source), 'utf8')).digest('hex'),
    created_at: String(entry.when),
  })));
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    expect(Array.from(await maintenance.sql`select hash, created_at from drizzle.__drizzle_migrations order by created_at`)).toEqual(expected);
    const columns = await maintenance.sql`select table_name, column_name from information_schema.columns
      where table_schema = 'public' and ((table_name = 'ranks' and column_name = 'color')
        or (table_name = 'attendances' and column_name = 'kind')
        or (table_name = 'memberships' and column_name = 'anniversary_on'))`;
    expect(Array.from(columns)).toEqual([{ table_name: 'ranks', column_name: 'color' }]);
  } finally { await maintenance.close(); }
});

it('rejects an unknown journal tag', async () => {
  await expect(createUpgradeTestDatabase(inject('testDatabase'), 'missing_migration'))
    .rejects.toThrow('Unknown migration tag: missing_migration');
});
