// SPDX-License-Identifier: AGPL-3.0-only
import { expect, inject, it } from 'vitest';
import { assertRestrictedAppRole, closeDatabase, initializeDatabase, openConnection } from './client.js';
import { databaseUrl, useTestDatabase } from './testing/database.js';

const database = useTestDatabase();

it('refuses REPLICATION on the app role and initializes after rollback', async () => {
  const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, database.name), 1);
  const sql = admin.sql;
  try {
    // Roles are shared by every database in the cluster. Keep the change in this transaction.
    await sql`begin`;
    await sql`alter role app replication`;
    await sql`set local role app`;
    await expect(assertRestrictedAppRole(sql)).rejects.toThrow('Application requires the restricted app database role');
  } finally {
    try { await sql`rollback`; } finally { await admin.close(); }
  }

  await expect(assertRestrictedAppRole(database.app.sql)).resolves.toBeUndefined();
  try { await initializeDatabase(database.appUrl); } finally { await closeDatabase(); }
});
