// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { openConnection, type Connection } from './client.js';
import { migrateDatabase } from './migrate.js';
import { assertCatalog } from './security/catalog.js';
import { databaseUrl, useTestDatabase } from './testing/database.js';

// After a rollback the previous release's code runs on the schema a newer release migrated (docs/versioning.md).
const database = useTestDatabase();
const gym = `gym_id = nullif(current_setting('app.gym_id', true), '')::uuid`;
const gymRow = `id = nullif(current_setting('app.gym_id', true), '')::uuid`;
const system = `current_setting('app.system', true) = 'on'`;
const forced = `alter table newer enable row level security; alter table newer force row level security;`;
const gymTable = `create table newer (id uuid primary key, gym_id uuid not null); ${forced}`;
const gymPolicy = `create policy newer_gym on newer to app using (${gym}) with check (${gym});`;
const safeGymTable = gymTable + gymPolicy;
let maintenance: Connection;
beforeAll(() => { maintenance = openConnection(database.maintenanceUrl, 1); });
afterEach(async () => { await maintenance.sql.unsafe('drop table if exists newer_child, newer'); });
afterAll(async () => { await maintenance.close(); });

describe('a table this image does not declare', () => {
  it.each([
    ['a gym table', safeGymTable],
    ['an append-only gym table', safeGymTable + 'revoke update, delete on newer from app;'],
    ['a gym table with a composite key', `create table newer (gym_id uuid not null, key text not null, primary key (gym_id, key)); ${forced}${gymPolicy}`],
    ['a gym table referencing a declared gym table by gym', `create table newer (id uuid primary key, gym_id uuid not null, member_id uuid not null,
      foreign key (gym_id, member_id) references members (gym_id, id)); ${forced}${gymPolicy}`],
    ['a system table', `create table newer (id uuid primary key, name text); ${forced}
      create policy newer_system on newer to app using (${system}) with check (${system});`],
    ['a system table referencing a declared gym row', `create table newer (id uuid primary key, member_gym uuid references gyms (id)); ${forced}
      create policy newer_system on newer to app using (${system}) with check (${system});`],
    ['a gym-scoped system table', `create table newer (id uuid primary key, gym_id uuid); ${forced}
      create policy newer_scoped on newer to app using ((${gym}) or (${system})) with check ((${gym}) or (${system}));`],
    ['a per-gym configuration table', `create table newer (id uuid primary key); ${forced}
      create policy newer_read on newer for select to app using ((${gymRow}) or (${system}));
      create policy newer_update on newer for update to app using ((${gymRow}) or (${system})) with check ((${gymRow}) or (${system}));
      create policy newer_insert on newer for insert to app with check (${system});
      create policy newer_delete on newer for delete to app using (${system});`],
  ])('is accepted as %s', async (_name, statements) => {
    await maintenance.sql.unsafe(statements);
    await expect(assertCatalog(database.app.sql)).resolves.toEqual({ tableCount: 70, tenantTableCount: expect.any(Number) });
  });

  it('counts as a tenant table only with the gym policy', async () => {
    await maintenance.sql.unsafe(safeGymTable);
    expect(await assertCatalog(database.app.sql)).toEqual({ tableCount: 70, tenantTableCount: 58 });
    await maintenance.sql.unsafe(`drop table newer; create table newer (id uuid primary key); ${forced}
      create policy newer_system on newer to app using (${system}) with check (${system});`);
    expect(await assertCatalog(database.app.sql)).toEqual({ tableCount: 70, tenantTableCount: 57 });
  });

  it.each([
    ['without row-level security', 'create table newer (id uuid primary key, gym_id uuid not null);', 'newer: invalid forced gym policy'],
    ['with no gym and no system policy', 'create table newer (id uuid primary key);', 'newer: unregistered system table'],
    ['with ENABLE but no FORCE', `create table newer (id uuid primary key, gym_id uuid not null); alter table newer enable row level security; ${gymPolicy}`,
      'newer: invalid forced gym policy'],
    ['with FORCE but RLS disabled', `create table newer (id uuid primary key, gym_id uuid not null); alter table newer force row level security; ${gymPolicy}`,
      'newer: invalid forced gym policy'],
    ['with no policy at all', gymTable, 'newer: invalid forced gym policy'],
    ['with an open policy', `${gymTable} create policy leak on newer to app using (true) with check (true);`, 'newer: invalid forced gym policy'],
    ['with an open policy beside the gym policy', `${safeGymTable} create policy leak on newer for select to app using (true);`, 'newer: invalid forced gym policy'],
    ['with a policy for every role', `${gymTable} create policy newer_gym on newer using (${gym}) with check (${gym});`, 'newer: invalid forced gym policy'],
    ['with a restrictive policy', `${gymTable} create policy newer_gym on newer as restrictive to app using (${gym}) with check (${gym});`, 'newer: invalid forced gym policy'],
    ['with a gym policy that skips writes', `${gymTable} create policy newer_gym on newer to app using (${gym}) with check (true);`, 'newer: invalid forced gym policy'],
    ['with a system policy for every role', `${gymTable} create policy newer_system on newer using (${system}) with check (${system});`, 'newer: invalid system access policy'],
    ['with a system policy beside an open read', `create table newer (id uuid primary key); ${forced}
      create policy newer_system on newer to app using (${system}) with check (${system}); create policy leak on newer for select to app using (true);`, 'newer: unregistered system table'],
    ['with a nullable gym_id', `create table newer (id uuid primary key, gym_id uuid); ${forced}${gymPolicy}`, 'newer: invalid gym_id'],
    ['with TRUNCATE for the app', `${safeGymTable} grant truncate on newer to app;`, 'newer: unexpected table privileges'],
    ['with REFERENCES for the app', `${safeGymTable} grant references on newer to app;`, 'newer: unexpected table privileges'],
    ['with TRIGGER for the app', `${safeGymTable} grant trigger on newer to app;`, 'newer: unexpected table privileges'],
    ['with a foreign key that skips gym_id', `${safeGymTable} create table newer_child (id uuid primary key, gym_id uuid not null, parent uuid references newer (id));
      alter table newer_child enable row level security; alter table newer_child force row level security;
      create policy newer_child_gym on newer_child to app using (${gym}) with check (${gym});`, 'unscoped foreign key'],
  ])('is refused %s', async (_name, statements, failure) => {
    await maintenance.sql.unsafe(statements);
    await expect(assertCatalog(database.app.sql)).rejects.toThrow(failure);
  });

  it('is refused under the wrong owner', async () => {
    await maintenance.sql.unsafe(safeGymTable);
    const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, database.name), 1);
    try {
      await admin.sql.unsafe('alter table newer owner to postgres');
      await expect(assertCatalog(database.app.sql)).rejects.toThrow('newer: wrong owner');
    } finally {
      await admin.sql.unsafe('drop table newer');
      await admin.close();
    }
  });
});

describe('a table this image declares', () => {
  it('fails when it is missing, even if a safe table stands in for it', async () => {
    await maintenance.sql.unsafe('alter table class_tags rename to newer');
    try { await expect(assertCatalog(database.app.sql)).rejects.toThrow('class_tags: missing table'); }
    finally { await maintenance.sql.unsafe('alter table newer rename to class_tags'); }
  });
  it('gets no newer table allowances: fewer privileges and a system policy both fail', async () => {
    await maintenance.sql.unsafe('revoke delete on members from app');
    try { await expect(assertCatalog(database.app.sql)).rejects.toThrow('members: unexpected table privileges'); }
    finally { await maintenance.sql.unsafe('grant delete on members to app'); }
    const [policy] = await maintenance.sql`select polname from pg_policy where polrelid = 'members'::regclass`;
    await maintenance.sql.unsafe(`drop policy ${String(policy?.polname)} on members; create policy ${String(policy?.polname)} on members to app using (${system}) with check (${system})`);
    try { await expect(assertCatalog(database.app.sql)).rejects.toThrow('members: invalid forced gym policy'); }
    finally { await maintenance.sql.unsafe(`drop policy ${String(policy?.polname)} on members; create policy ${String(policy?.polname)} on members to app using (${gym}) with check (${gym})`); }
  });
});

it('starts this image on a database a newer release migrated: its migrations stay applied and its table stays', async () => {
  await maintenance.sql.unsafe(safeGymTable);
  const [latest] = await maintenance.sql`select max(created_at) as at from drizzle.__drizzle_migrations`;
  await maintenance.sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('newer-release', ${Number(latest?.at) + 1000})`;
  try {
    await expect(migrateDatabase(database.maintenanceUrl)).resolves.toBeUndefined();
    await expect(assertCatalog(database.app.sql)).resolves.toMatchObject({ tableCount: 70 });
    expect(await maintenance.sql`select 1 from drizzle.__drizzle_migrations where hash = 'newer-release'`).toHaveLength(1);
  } finally { await maintenance.sql`delete from drizzle.__drizzle_migrations where hash = 'newer-release'`; }
});
