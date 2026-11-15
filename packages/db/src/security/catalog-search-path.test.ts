// SPDX-License-Identifier: AGPL-3.0-only
import { expect, inject, it } from 'vitest';
import { openConnection } from '../client.js';
import { migrateDatabase } from '../migrate.js';
import { databaseUrl, useTestDatabase } from '../testing/database.js';
import { createFactories } from '../testing/factories.js';
import { uuidv7 } from '../id.js';
import { households } from '../schema/members.js';
import { assertCatalog } from './catalog.js';

const database = useTestDatabase();

it('pins app, auth system and maintenance pools to public despite role, database and URL defaults', async () => {
  const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, database.name), 1);
  try {
    await admin.sql`alter database ${admin.sql(database.name)} set search_path to app, public`;
    for (const role of ['app', 'maintenance']) {
      await admin.sql`alter role ${admin.sql(role)} in database ${admin.sql(database.name)} set search_path to app, public`;
    }
    for (const [url, context] of [[database.appUrl, undefined], [database.appUrl, 'system'], [database.maintenanceUrl, undefined]] as const) {
      const supplied = new URL(url);
      supplied.searchParams.set('search_path', 'app,public');
      const pool = openConnection(supplied.toString(), 2, context);
      try {
        // Hold both sessions at once so every connection in the pool is exercised.
        const sessions = await Promise.all([pool.sql.reserve(), pool.sql.reserve()]);
        try {
          for (const session of sessions) {
            expect((await session`show search_path`)[0]?.search_path).toBe('public');
            if (context === 'system') expect((await session`select current_setting('app.system') as context`)[0]?.context).toBe('on');
          }
        } finally { for (const session of sessions) session.release(); }
      } finally { await pool.close(); }
    }
  } finally {
    await admin.sql`alter database ${admin.sql(database.name)} reset all`;
    for (const role of ['app', 'maintenance']) {
      await admin.sql`alter role ${admin.sql(role)} in database ${admin.sql(database.name)} reset all`;
    }
    await admin.close();
  }
});

it.each(['database', 'app', 'maintenance'])('refuses persistent %s settings even when search_path is pinned', async target => {
  const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, database.name), 1);
  try {
    if (target === 'database') await admin.sql`alter database ${admin.sql(database.name)} set statement_timeout to '5s'`;
    else await admin.sql`alter role ${admin.sql(target)} in database ${admin.sql(database.name)} set search_path to app, public`;
    if (target === 'database') await admin.sql`alter database ${admin.sql(database.name)} set lock_timeout to '1s'`;
    else await admin.sql`alter role ${admin.sql(target)} in database ${admin.sql(database.name)} set lock_timeout to '1s'`;
    const prefix = `Unexpected database or role settings: database ${database.name}, role ${target === 'database' ? 'all roles' : target}: `;
    await expect(assertCatalog(database.app.sql)).rejects.toThrow(prefix + (target === 'database' ? 'statement_timeout' : 'search_path'));
    await expect(assertCatalog(database.app.sql)).rejects.toThrow(prefix + 'lock_timeout');
    await expect(migrateDatabase(database.maintenanceUrl)).rejects.toThrow('Unexpected database or role settings');
  } finally {
    if (target === 'database') await admin.sql`alter database ${admin.sql(database.name)} reset all`;
    else await admin.sql`alter role ${admin.sql(target)} in database ${admin.sql(database.name)} reset all`;
    await admin.close();
  }
  await expect(assertCatalog(database.app.sql)).resolves.toBeDefined();
});

it.each(['app', 'maintenance', 'all'])('refuses global %s role defaults', async role => {
  const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, database.name), 1);
  try {
    // Never publish a global default to the other test files sharing these roles.
    // The single-session pool sees its own uncommitted catalog change.
    await admin.sql`begin`;
    if (role === 'all') await admin.sql`alter role all set search_path to app, public`;
    else await admin.sql`alter role ${admin.sql(role)} set search_path to app, public`;
    await expect(assertCatalog(admin.sql)).rejects.toThrow(`Unexpected database or role settings: database all databases, role ${role === 'all' ? 'all roles' : role}: search_path`);
  } finally {
    await admin.sql`rollback`;
    await admin.close();
  }
});

it('rejects look-alike owner views outside public while scoped queries still read only their gym', async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  const make = createFactories(database), gymA = uuidv7(), gymB = uuidv7();
  await make('gyms', gymA); await make('gyms', gymB);
  const own = await make('households', gymA);
  await make('households', gymB);
  try {
    await maintenance.sql`create schema app authorization maintenance`;
    await maintenance.sql`grant usage on schema app to app`;
    await maintenance.sql`create view app.households as select * from public.households`;
    await maintenance.sql`grant select on app.households to app`;
    // The planted view bypasses RLS as its owner; unqualified app queries must never resolve to it.
    expect(await database.app.sql`select id from app.households`).toHaveLength(2);
    expect(await database.forGym(gymA, tx => tx.select({ id: households.id }).from(households))).toEqual([{ id: own.id }]);
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('app: unexpected usable schema');
    await expect(migrateDatabase(database.maintenanceUrl)).rejects.toThrow('app: unexpected usable schema');
  } finally {
    await maintenance.sql`drop schema if exists app cascade`;
    await maintenance.close();
  }
  await expect(migrateDatabase(database.maintenanceUrl)).resolves.toBeUndefined();
});

it('ignores the checking session\'s own temporary schema', async () => {
  // Only maintenance (the database owner) has TEMP; the app role can't create one.
  const session = openConnection(database.maintenanceUrl, 1);
  try {
    await session.sql`create temporary table catalog_temp_probe (id int)`;
    await expect(assertCatalog(session.sql)).resolves.toBeDefined();
  } finally { await session.close(); }
});

it('rejects an extra schema usable only by maintenance', async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`create schema other authorization maintenance`;
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('other: unexpected usable schema');
  } finally {
    await maintenance.sql`drop schema if exists other cascade`;
    await maintenance.close();
  }
});

it('bootstrap leaves app with no privileges on drizzle', async () => {
  const [privileges] = await database.app.sql`select has_schema_privilege('app', 'drizzle', 'USAGE') as usage,
    has_schema_privilege('app', 'drizzle', 'CREATE') as create`;
  expect(privileges).toEqual({ usage: false, create: false });
  await expect(assertCatalog(database.app.sql)).resolves.toBeDefined();
});

it.each(['app', 'public'])('refuses drizzle USAGE granted through %s', async role => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    if (role === 'public') await maintenance.sql`grant usage on schema drizzle to public`;
    else await maintenance.sql`grant usage on schema drizzle to app`;
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('drizzle: unexpected app schema USAGE');
    await expect(migrateDatabase(database.maintenanceUrl)).rejects.toThrow('drizzle: unexpected app schema USAGE');
  } finally {
    if (role === 'public') await maintenance.sql`revoke usage on schema drizzle from public`;
    else await maintenance.sql`revoke usage on schema drizzle from app`;
    await maintenance.close();
  }
});

it('refuses drizzle CREATE granted to app without USAGE', async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`grant create on schema drizzle to app`;
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('drizzle: unexpected app schema CREATE');
    await expect(migrateDatabase(database.maintenanceUrl)).rejects.toThrow('drizzle: unexpected app schema CREATE');
  } finally {
    await maintenance.sql`revoke create on schema drizzle from app`;
    await maintenance.close();
  }
});

it.each([
  ['owner view', 'create view drizzle.catalog_probe as select * from public.households', 'view without security_invoker'],
  ['materialized view', 'create materialized view drizzle.catalog_probe as select * from public.households; grant select (id) on drizzle.catalog_probe to app', 'materialized view without row-level security'],
  ['executable definer', "create function drizzle.catalog_probe() returns bigint language sql security definer as 'select count(*) from public.households'", 'security definer function'],
  ['trigger definer', `create function drizzle.catalog_probe() returns trigger language plpgsql security definer as 'begin return new; end';
    revoke execute on function drizzle.catalog_probe() from public, app;
    create trigger catalog_probe before insert on public.households for each row execute function drizzle.catalog_probe()`, 'security definer function'],
])('checks a drizzle %s even without app schema access', async (_name, statements, failure) => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql.unsafe(statements);
    await expect(assertCatalog(database.app.sql)).rejects.toThrow('drizzle.catalog_probe: ' + failure);
    await expect(migrateDatabase(database.maintenanceUrl)).rejects.toThrow('drizzle.catalog_probe: ' + failure);
  } finally {
    await maintenance.sql`drop trigger if exists catalog_probe on public.households`;
    // The relation's kind differs between cases, so drop only what this case created.
    if (_name === 'owner view') await maintenance.sql`drop view drizzle.catalog_probe`;
    else if (_name === 'materialized view') await maintenance.sql`drop materialized view drizzle.catalog_probe`;
    else await maintenance.sql`drop function drizzle.catalog_probe()`;
    await maintenance.close();
  }
});
