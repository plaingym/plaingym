// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path';
import { expect, inject, it } from 'vitest';
// Test-only maintenance access builds a hostile snapshot and cleans up its schemas.
// eslint-disable-next-line no-restricted-imports
import { openConnection } from '@plaingym/db/client';
import { databaseUrl } from '@plaingym/db/testing/database';
import { saveStream } from './backups.files.js';
import { PostgresMaintenance } from './backups.database.js';
import { useRestoreFixture } from './restore.fixture.test-helper.js';

const f = useRestoreFixture();

it.each(['app', 'drizzle usage', 'drizzle view'])('keeps a restored snapshot with %s gated before rekey or upload activation', async variant => {
  const source = openConnection(f.source.maintenanceUrl, 1);
  const target = openConnection(f.target.maintenanceUrl, 1);
  const originalDump = f.sourceMaintenance.dump;
  try {
    const schema = variant === 'app' ? 'app' : 'drizzle';
    if (schema === 'app') await source.sql`create schema app authorization maintenance`;
    if (variant !== 'drizzle view') await source.sql`grant usage on schema ${source.sql(schema)} to app`;
    if (variant !== 'drizzle usage') {
      await source.sql`create view ${source.sql(schema)}.households as select * from public.households`;
      await source.sql`grant select on ${source.sql(schema)}.households to app`;
    }
    // A bucket writer can supply an archive with schemas our own dumps do not include.
    f.sourceMaintenance.dump = () => f.sourceMaintenance.tool('pg_dump', [
      '--format=custom', '--no-owner', '--schema=public', '--schema=drizzle', ...(schema === 'app' ? ['--schema=app'] : []),
    ]);
    const snapshot = await f.backup().snapshot();
    const phases: string[] = [];
    await expect(f.restore(phase => { phases.push(phase); }).restore(snapshot.id, f.identity)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining(variant === 'app' ? 'app: unexpected usable schema' :
        variant === 'drizzle usage' ? 'drizzle: unexpected app schema USAGE' : 'drizzle.households: view without security_invoker') }),
    });
    expect(phases).toContain('database_restored');
    expect(phases).not.toContain('migrated');
    expect(phases).not.toContain('secret_field');
    expect(await f.gate().isClosed()).toBe(true);
    expect(await new Response(await f.restoredUploads().get(f.gymId + '/sentinel')).text()).toBe('live upload sentinel');
  } finally {
    f.sourceMaintenance.dump = originalDump;
    await source.sql`drop schema if exists app cascade`;
    await target.sql`drop schema if exists app cascade`;
    for (const connection of [source, target]) {
      await connection.sql`drop view if exists drizzle.households`;
      await connection.sql`revoke all on schema drizzle from app`;
    }
    await source.close(); await target.close();
  }
});

it.each(['extra schema', 'database settings', 'maintenance settings'])('restores a good archive after refusing one that leaves %s', async variant => {
  const source = openConnection(f.source.maintenanceUrl, 1);
  const target = openConnection(f.target.maintenanceUrl, 1);
  const good = join(f.root, 'good.dump'), hostile = join(f.root, 'hostile.dump');
  try {
    await saveStream(good, await f.sourceMaintenance.dump());
    const expected = await source.sql`select id, stripe_config_encrypted, qr_key_encrypted from public.gyms order by id`;
    if (variant === 'extra schema') {
      // A name needing quoting also exercises the reset's identifier handling.
      await source.sql`create schema "restore leftovers" authorization maintenance`;
      await source.sql`create table "restore leftovers".probe (id int)`;
    } else if (variant === 'database settings') {
      // COPY evaluates CHECKs, so loading this archive installs a persistent
      // database default as maintenance, just as untrusted snapshot SQL could.
      await source.sql`create function public.restore_setting_probe() returns boolean language plpgsql as '
        begin
          execute format(''alter database %I set statement_timeout to %L'', current_database(), ''5s'');
          execute format(''alter database %I set lock_timeout to %L'', current_database(), ''1s'');
          return true;
        end'`;
      await source.sql`create table public.restore_probe (id int check (public.restore_setting_probe()))`;
      await source.sql`insert into public.restore_probe values (1)`;
    } else {
      await source.sql`create function public.restore_setting_probe() returns boolean language plpgsql as '
        begin
          execute format(''alter role maintenance in database %I set statement_timeout to %L'', current_database(), ''5s'');
          return true;
        end'`;
      await source.sql`create table public.restore_probe (id int check (public.restore_setting_probe()))`;
      await source.sql`insert into public.restore_probe values (1)`;
    }
    await saveStream(hostile, await f.sourceMaintenance.tool('pg_dump', [
      '--format=custom', '--no-owner', '--schema=public', '--schema=drizzle',
      ...(variant === 'extra schema' ? ['--schema=restore leftovers'] : []),
    ]));
    await f.targetMaintenance.restore(hostile);
    const failure = variant === 'extra schema' ? 'restore leftovers: unexpected usable schema' : variant === 'maintenance settings'
      ? 'role maintenance' : `Unexpected database or role settings: database ${f.target.name}, role all roles: statement_timeout`;
    await expect(f.targetMaintenance.migrate()).rejects.toThrow(failure);
    if (variant === 'database settings') await expect(f.targetMaintenance.migrate()).rejects.toThrow('role all roles: lock_timeout');
    await f.targetMaintenance.restore(good);
    await expect(f.targetMaintenance.migrate()).resolves.toBeUndefined();
    expect(await target.sql`select id, stripe_config_encrypted, qr_key_encrypted from public.gyms order by id`).toEqual(expected);
    expect(await target.sql`select 1 from pg_catalog.pg_namespace where nspname = 'restore leftovers'`).toHaveLength(0);
    expect(await target.sql`select 1 from pg_catalog.pg_db_role_setting
      where setdatabase = (select oid from pg_catalog.pg_database where datname = current_database())`).toHaveLength(0);
    expect(await target.sql`select count(*) from drizzle.__drizzle_migrations`).toEqual(
      await source.sql`select count(*) from drizzle.__drizzle_migrations`);
  } finally {
    for (const connection of [source, target]) {
      await connection.sql`drop schema if exists "restore leftovers" cascade`;
      await connection.sql`drop table if exists public.restore_probe`;
      await connection.sql`drop function if exists public.restore_setting_probe()`;
      const name = connection === source ? f.source.name : f.target.name;
      await connection.sql`alter database ${connection.sql(name)} reset all`;
      await connection.sql`alter role maintenance in database ${connection.sql(name)} reset all`;
      await connection.close();
    }
  }
});

it.each(['database', 'role'])('clears a stored read-only %s default that would block its own reset', async kind => {
  const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, f.target.name), 1);
  const good = join(f.root, 'good.dump');
  try {
    await saveStream(good, await f.sourceMaintenance.dump());
    // Snapshot SQL runs as maintenance, which owns the database, so it can store this default.
    if (kind === 'database') await admin.sql`alter database ${admin.sql(f.target.name)} set default_transaction_read_only to on`;
    else await admin.sql`alter role maintenance in database ${admin.sql(f.target.name)} set default_transaction_read_only to on`;
    let pgOptions: string | undefined;
    const maintenance = new PostgresMaintenance(
      f.target.maintenanceUrl, (tool, options) => { if (tool === 'pg_restore') pgOptions = options.env.PGOPTIONS; return f.targetMaintenance.tools(tool, options); });
    await maintenance.restore(good);
    expect(pgOptions).toContain('-c default_transaction_read_only=off');
    expect(pgOptions).toContain('-c statement_timeout=0');
    await expect(f.targetMaintenance.migrate()).resolves.toBeUndefined();
    expect(await admin.sql`select 1 from pg_catalog.pg_db_role_setting
      where setdatabase = (select oid from pg_catalog.pg_database where datname = current_database())`).toHaveLength(0);
  } finally {
    await admin.sql`alter database ${admin.sql(f.target.name)} reset all`;
    await admin.sql`alter role maintenance in database ${admin.sql(f.target.name)} reset all`;
    await admin.close();
  }
});

it('preserves another owner\'s schema and role defaults for administrator recovery', async () => {
  const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, f.target.name), 1);
  const good = join(f.root, 'good.dump');
  try {
    await saveStream(good, await f.sourceMaintenance.dump());
    await admin.sql`create schema external`;
    await admin.sql`grant usage on schema external to maintenance`;
    await admin.sql`create table external.sentinel (value text)`;
    await admin.sql`insert into external.sentinel values ('keep this data')`;
    await admin.sql`alter role app in database ${admin.sql(f.target.name)} set statement_timeout to '5s'`;
    await f.targetMaintenance.restore(good);
    expect(await admin.sql`select value from external.sentinel`).toEqual([{ value: 'keep this data' }]);
    await expect(f.targetMaintenance.migrate()).rejects.toThrow(`database ${f.target.name}, role app: statement_timeout`);
    await admin.sql`alter role app in database ${admin.sql(f.target.name)} reset all`;
    await expect(f.targetMaintenance.migrate()).rejects.toThrow('external: unexpected usable schema');
  } finally {
    await admin.sql`alter role app in database ${admin.sql(f.target.name)} reset all`;
    await admin.sql`drop schema if exists external cascade`;
    await admin.close();
  }
  await expect(f.targetMaintenance.migrate()).resolves.toBeUndefined();
});
