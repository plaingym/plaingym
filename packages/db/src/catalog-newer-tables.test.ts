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
    await expect(assertCatalog(database.app.sql)).resolves.toEqual({ tableCount: 74, tenantTableCount: expect.any(Number) });
  });

  it('counts as a tenant table only with the gym policy', async () => {
    await maintenance.sql.unsafe(safeGymTable);
    expect(await assertCatalog(database.app.sql)).toEqual({ tableCount: 74, tenantTableCount: 62 });
    await maintenance.sql.unsafe(`drop table newer; create table newer (id uuid primary key); ${forced}
      create policy newer_system on newer to app using (${system}) with check (${system});`);
    expect(await assertCatalog(database.app.sql)).toEqual({ tableCount: 74, tenantTableCount: 61 });
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

describe('app role memberships at startup', () => {
  it.each([
    ['a superuser role', 'superuser', false],
    ['an indirect BYPASSRLS role', 'bypassrls', true],
    ['a CREATEROLE role', 'createrole', false],
    ['maintenance', null, false],
  ])('refuses %s and names the role', async (_name, attributes, indirect) => {
    const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, database.name), 1);
    const sql = admin.sql;
    const role = attributes === null ? 'maintenance' : `${database.name}_privileged`;
    try {
      // Keep cluster-wide memberships invisible to other test databases.
      await sql`begin`;
      if (attributes !== null) await sql`create role ${sql(role)} nologin ${sql.unsafe(attributes)}`;
      if (indirect) {
        const intermediate = `${database.name}_intermediate`;
        await sql`create role ${sql(intermediate)} nologin`;
        await sql`grant ${sql(role)} to ${sql(intermediate)} with inherit false, set false`;
        await sql`grant ${sql(intermediate)} to app`;
      } else {
        await sql`grant ${sql(role)} to app`;
      }
      await sql`set local role maintenance`;
      await expect(assertCatalog(sql)).rejects.toThrow(`app is a member of privileged role ${role}`);
    } finally {
      try { await sql`rollback`; } finally { await admin.close(); }
    }
  });

  it('accepts startup with a plain app membership', async () => {
    const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, database.name), 1);
    const sql = admin.sql;
    const role = `${database.name}_plain`;
    try {
      await sql`create role ${sql(role)} nologin`;
      await sql`grant ${sql(role)} to app`;
      await expect(migrateDatabase(database.maintenanceUrl)).resolves.toBeUndefined();
    } finally {
      try { await sql`drop role if exists ${sql(role)}`; } finally { await admin.close(); }
    }
  });
});

describe('a view, materialized view, foreign table or function this image does not declare', () => {
  const invokerView = 'create view newer_view with (security_invoker = true) as select id, gym_id from members;';
  const matview = 'create materialized view newer_matview as select id, gym_id from members with no data;';
  // No handler or remote connection is needed to check catalog privileges.
  const foreignTable = `create foreign data wrapper newer_fdw;
    create server newer_server foreign data wrapper newer_fdw;
    create foreign table newer_foreign (id uuid, gym_id uuid) server newer_server;`;
  const definer = `create function newer_fn() returns bigint language sql security definer as 'select count(*) from members';`;
  afterEach(async () => {
    await maintenance.sql.unsafe('drop trigger if exists newer_trigger on members; drop function if exists newer_trigger_fn(); drop view if exists newer_view; drop materialized view if exists newer_matview; drop function if exists newer_fn()');
  });
  it.each([
    ['a security_invoker view', invokerView],
    ['a security_invoker view whose option reads t', 'create view newer_view with (security_invoker = t) as select id, gym_id from members;'],
    ['an owner view the app cannot use', 'create view newer_view as select id, gym_id from members; revoke all on newer_view from app, public;'],
    ['a materialized view the app cannot use', `${matview} revoke all on newer_matview from app;`],
    ['a security definer function the app cannot run', `${definer} revoke execute on function newer_fn() from public, app;`],
    ['a function that runs as its caller', `create function newer_fn() returns bigint language sql as 'select count(*) from members'; grant execute on function newer_fn() to app;`],
  ])('is accepted as %s', async (_name, statements) => {
    await maintenance.sql.unsafe(statements);
    await expect(assertCatalog(database.app.sql)).resolves.toEqual({ tableCount: 73, tenantTableCount: expect.any(Number) });
  });
  it.each([
    ['a view that runs as its owner', 'create view newer_view as select id, gym_id from members;', 'newer_view: view without security_invoker'],
    ['a view with security_invoker off', 'create view newer_view with (security_invoker = false) as select id, gym_id from members;', 'newer_view: view without security_invoker'],
    ['an owner view with a public grant', 'create view newer_view as select id, gym_id from members; revoke all on newer_view from app; grant select on newer_view to public;', 'newer_view: view without security_invoker'],
    ['an owner view with only a column grant', 'create view newer_view as select id, gym_id from members; revoke all on newer_view from app; grant select (id) on newer_view to app;', 'newer_view: view without security_invoker'],
    ['an owner view with only REFERENCES', 'create view newer_view as select id, gym_id from members; revoke all on newer_view from app; grant references (id) on newer_view to app;', 'newer_view: unexpected view privileges'],
    ['a view with TRIGGER for the app', `${invokerView} grant trigger on newer_view to app;`, 'newer_view: unexpected view privileges'],
    ['a materialized view the app can read', `${matview} grant select on newer_matview to app;`, 'newer_matview: materialized view without row-level security'],
    ['a security definer function the app can run', `${definer} grant execute on function newer_fn() to app;`, 'newer_fn: security definer function'],
    ['a materialized view the app can read through a column grant', `${matview} revoke all on newer_matview from app; grant select (id) on newer_matview to app;`, 'newer_matview: materialized view without row-level security'],
    ['a security definer trigger function the app cannot run', `create function newer_trigger_fn() returns trigger language plpgsql security definer as 'begin return new; end';
      revoke execute on function newer_trigger_fn() from public, app;
      create trigger newer_trigger before insert on members for each row execute function newer_trigger_fn();`, 'newer_trigger_fn: security definer function'],
  ])('is refused as %s', async (_name, statements, failure) => {
    await maintenance.sql.unsafe(statements);
    await expect(assertCatalog(database.app.sql)).rejects.toThrow(failure);
  });
  it('is refused under the wrong owner', async () => {
    await maintenance.sql.unsafe(invokerView);
    const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, database.name), 1);
    try {
      await admin.sql.unsafe('alter view newer_view owner to postgres');
      await expect(assertCatalog(database.app.sql)).rejects.toThrow('newer_view: wrong owner');
    } finally {
      await admin.sql.unsafe('drop view newer_view');
      await admin.close();
    }
  });
  it.each([
    ['view', 'newer_view', 'create view newer_view as select id, gym_id from members;'],
    ['materialized view', 'newer_matview', matview],
  ])('refuses a %s app owns even with its own privileges revoked', async (kind, name, create) => {
    await maintenance.sql.unsafe(create);
    const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, database.name), 1);
    try {
      await admin.sql.unsafe(`alter ${kind} ${name} owner to app; revoke all on ${name} from app, public`);
      await expect(assertCatalog(database.app.sql)).rejects.toThrow(`${name}: wrong owner`);
    } finally {
      await admin.sql.unsafe(`drop ${kind} ${name}`);
      await admin.close();
    }
  });
  it.each([
    ['view', 'newer_view', 'create view newer_view as select 1 as probe'],
    ['materialized view', 'newer_matview', matview],
    ['foreign table', 'newer_foreign', foreignTable],
  ])('refuses startup when app is a member of a %s owner role, whatever the membership options', async (kind, name, create) => {
    const owner = `${database.name}_owner`;
    const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, database.name), 1);
    const sql = admin.sql;
    try {
      await sql`create role ${sql(owner)} nologin`;
      await sql.unsafe(create);
      if (kind === 'foreign table') await sql`grant usage on foreign server newer_server to ${sql(owner)}`;
      await sql`alter ${sql.unsafe(kind)} ${sql(name)} owner to ${sql(owner)}`;
      await sql`revoke all on ${sql(name)} from app, public, ${sql(owner)}`;
      await expect(migrateDatabase(database.maintenanceUrl)).resolves.toBeUndefined();

      const failure = `${name}: app is a member of owner role ${owner}`;
      const options = async () => (await database.app.sql`
        select has_table_privilege('app', ${name}::text, 'SELECT') as can_select,
          pg_has_role('app', ${owner}::text, 'USAGE') as can_use,
          pg_has_role('app', ${owner}::text, 'SET') as can_switch,
          pg_has_role('app', ${owner}::text, 'USAGE WITH ADMIN OPTION') as can_grant
      `)[0];
      // ADMIN OPTION alone lets app grant itself INHERIT or SET on the owner later.
      await sql`grant ${sql(owner)} to app with inherit false, set false, admin true`;
      expect(await options()).toEqual({ can_select: false, can_use: false, can_switch: false, can_grant: true });
      await expect(assertCatalog(database.app.sql)).rejects.toThrow(failure);
      await expect(migrateDatabase(database.maintenanceUrl)).rejects.toThrow(failure);

      await sql`revoke ${sql(owner)} from app`;
      await sql`grant ${sql(owner)} to app with inherit false, set false`;
      expect(await options()).toEqual({ can_select: false, can_use: false, can_switch: false, can_grant: false });
      await expect(migrateDatabase(database.maintenanceUrl)).rejects.toThrow(failure);

      await sql`grant ${sql(owner)} to app with set true`;
      expect(await options()).toEqual({ can_select: false, can_use: false, can_switch: true, can_grant: false });
      await expect(migrateDatabase(database.maintenanceUrl)).rejects.toThrow(failure);

      await sql`grant ${sql(owner)} to app with set false, inherit true`;
      await expect(migrateDatabase(database.maintenanceUrl)).rejects.toThrow(failure);
    } finally {
      try {
        if (kind === 'foreign table') await sql`drop foreign data wrapper if exists newer_fdw cascade`;
        else await sql`drop ${sql.unsafe(kind)} if exists ${sql(name)}`;
        await sql`drop role if exists ${sql(owner)}`;
      } finally { await admin.close(); }
    }
    await expect(migrateDatabase(database.maintenanceUrl)).resolves.toBeUndefined();
  });
  it.each([
    ['view', 'newer_view', 'create view newer_view as select id, gym_id from members;', 'view without security_invoker'],
    ['materialized view', 'newer_matview', matview, 'materialized view without row-level security'],
  ])('accepts an extension-style %s with another owner only until app gains a privilege', async (kind, name, create, failure) => {
    await maintenance.sql.unsafe(`${create} revoke all on ${name} from app, public`);
    const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, database.name), 1);
    try {
      await admin.sql.unsafe(`alter ${kind} ${name} owner to postgres`);
      await expect(assertCatalog(database.app.sql)).resolves.toMatchObject({ tableCount: 73 });
      await expect(migrateDatabase(database.maintenanceUrl)).resolves.toBeUndefined();
      await admin.sql.unsafe(`grant select (id) on ${name} to app`);
      await expect(assertCatalog(database.app.sql)).rejects.toThrow(`${name}: wrong owner`);
      await expect(migrateDatabase(database.maintenanceUrl)).rejects.toThrow(`${name}: ${failure}`);
      await admin.sql.unsafe(`revoke all on ${name} from app; grant select on ${name} to public`);
      await expect(assertCatalog(database.app.sql)).rejects.toThrow(`${name}: wrong owner`);
      await admin.sql.unsafe(`revoke all on ${name} from public; grant ${kind === 'view' ? 'trigger' : 'maintain'} on ${name} to app`);
      await expect(assertCatalog(database.app.sql)).rejects.toThrow(`${name}: unexpected view privileges`);
    } finally {
      await admin.sql.unsafe(`drop ${kind} ${name}`);
      await admin.close();
    }
  });
  it('accepts an inaccessible foreign table owned by another role, but still refuses app privileges and ownership', async () => {
    const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, database.name), 1);
    try {
      await admin.sql.unsafe(foreignTable + 'revoke all on newer_foreign from app, public;');
      await expect(assertCatalog(database.app.sql)).resolves.toMatchObject({ tableCount: 73 });
      await expect(migrateDatabase(database.maintenanceUrl)).resolves.toBeUndefined();
      await admin.sql.unsafe('grant select (id) on newer_foreign to app');
      await expect(assertCatalog(database.app.sql)).rejects.toThrow('newer_foreign: foreign table without row-level security');
      await admin.sql.unsafe('revoke all on newer_foreign from app; grant select on newer_foreign to public');
      await expect(assertCatalog(database.app.sql)).rejects.toThrow('newer_foreign: foreign table without row-level security');
      await admin.sql.unsafe('revoke all on newer_foreign from public; grant references (id) on newer_foreign to app');
      await expect(assertCatalog(database.app.sql)).rejects.toThrow('newer_foreign: unexpected view privileges');
      await admin.sql.unsafe('revoke all on newer_foreign from app; alter foreign table newer_foreign owner to app');
      await expect(assertCatalog(database.app.sql)).rejects.toThrow('newer_foreign: wrong owner');
    } finally {
      await admin.sql.unsafe('drop foreign data wrapper if exists newer_fdw cascade');
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
    await expect(assertCatalog(database.app.sql)).resolves.toMatchObject({ tableCount: 74 });
    expect(await maintenance.sql`select 1 from drizzle.__drizzle_migrations where hash = 'newer-release'`).toHaveLength(1);
  } finally { await maintenance.sql`delete from drizzle.__drizzle_migrations where hash = 'newer-release'`; }
});
