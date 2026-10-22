// SPDX-License-Identifier: AGPL-3.0-only
import { expect, inject, it } from 'vitest';
import { closeDatabase, initializeDatabase, openConnection } from './client.js';
import { migrateDatabase } from './migrate.js';
import { applySecurity } from './security/apply.js';
import { assertCatalog } from './security/catalog.js';
import { cloneDatabase, useTestDatabase } from './testing/database.js';
import { createFactories } from './testing/factories.js';
import { uuidv7 } from './id.js';
import { households } from './schema/members.js';
const database = useTestDatabase();
it('refuses to initialize application access with maintenance credentials', async () => {
  await expect(initializeDatabase(database.maintenanceUrl)).rejects.toThrow('restricted app');
  try { await initializeDatabase(database.appUrl); } finally { await closeDatabase(); }
});
it('creates independent template clones with restricted app connections', async () => {
  const other = await cloneDatabase(inject('testDatabase'));
  try {
    expect(other.name).not.toBe(database.name);
    const gym = uuidv7();
    const first = createFactories(database), second = createFactories(other);
    await first('gyms', gym); await second('gyms', gym);
    await first('households', gym);
    expect(await database.forGym(gym, (tx) => tx.select().from(households))).toHaveLength(1);
    expect(await other.forGym(gym, (tx) => tx.select().from(households))).toEqual([]);
    expect(await assertCatalog(other.app.sql)).toEqual({ tableCount: 51, tenantTableCount: 41 });
  } finally { await other.cleanup(); }
});
it('serializes concurrent migration runners and keeps security setup idempotent', async () => {
  await Promise.all([migrateDatabase(database.maintenanceUrl), migrateDatabase(database.maintenanceUrl)]);
  expect(await assertCatalog(database.app.sql)).toEqual({ tableCount: 51, tenantTableCount: 41 });
});
it('detects policy, FORCE, unregistered table and privilege drift', async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`alter table members no force row level security`;
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('members: invalid forced gym policy');
    await applySecurity(maintenance.sql);
    await maintenance.sql`alter table members disable row level security`;
    await applySecurity(maintenance.sql);
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('members: invalid forced gym policy');
    await maintenance.sql`alter table members enable row level security`;
    await applySecurity(maintenance.sql);
    await maintenance.sql`create policy permissive_leak on members for select to app using (true)`;
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('members: invalid forced gym policy');
    await maintenance.sql`drop policy permissive_leak on members`;
    await maintenance.sql`grant update on audit_events to app`;
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('audit_events');
    await applySecurity(maintenance.sql);
    await maintenance.sql`grant update (snapshot) on waiver_signatures to app`;
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('waiver_signatures.snapshot');
    await applySecurity(maintenance.sql);
    await assertCatalog(database.app.sql);
    await maintenance.sql`grant truncate on members to app`;
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('members: unexpected table privileges');
    await maintenance.sql`revoke truncate on members from app`;
    await maintenance.sql`create table rogue (id uuid primary key)`;
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('rogue: unregistered system table');
    await maintenance.sql`drop table rogue`;
    await maintenance.sql`revoke select on members from app`;
    await applySecurity(maintenance.sql);
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('members: unexpected table privileges');
    await maintenance.sql`grant select on members to app`;
    // System tables: their declared access policies, ENABLE and FORCE are all checked too.
    await maintenance.sql`create policy gym_leak on gyms for select to app using (true)`;
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('gyms: invalid system access policy');
    await maintenance.sql`drop policy gym_leak on gyms`;
    await maintenance.sql`alter table auth_user no force row level security`;
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('auth_user: invalid system access policy');
    await applySecurity(maintenance.sql);
    await maintenance.sql`alter table jobs disable row level security`;
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('jobs: invalid system access policy');
    await maintenance.sql`alter table jobs enable row level security`;
    await applySecurity(maintenance.sql);
    await maintenance.sql`drop policy stripe_events_gym_policy on stripe_events`;
    await maintenance.sql`create policy stripe_events_gym_policy on stripe_events to app using (current_setting('app.system', true) = 'on' or true)`;
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('stripe_events: invalid system access policy');
  } finally { await maintenance.close(); }
});
