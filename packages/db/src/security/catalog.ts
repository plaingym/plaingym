// SPDX-License-Identifier: AGPL-3.0-only
import { getTableName } from 'drizzle-orm';
import type { Sql } from '../client.js';
import * as schema from '../schema/index.js';
import { systemTables } from '../../system-tables.mjs';
import { appendOnlyTables, mutableAttemptColumns } from './apply.js';
const expectedTables = Object.values(schema).map(getTableName).sort();
const normalize = (expression: string) => expression.toLowerCase().replaceAll('::text', '').replace(/[()\s]/g, '');
const expectedPolicy = normalize("gym_id = nullif(current_setting('app.gym_id', true), '')::uuid");
/** Checks the live catalog, including properties not represented by Drizzle snapshots. */
export async function assertCatalog(sql: Sql) {
  const failures: string[] = [];
  const roles = await sql`
    select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
    from pg_roles where rolname in ('app', 'maintenance')
  `;
  for (const name of ['app', 'maintenance']) {
    const role = roles.find((row) => row.rolname === name);
    if (!role || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication ||
        !role.rolcanlogin || role.rolbypassrls !== (name === 'maintenance')) failures.push('Unsafe role: ' + name);
  }
  const [privileges] = await sql`
    select pg_has_role('app', 'maintenance', 'MEMBER') as member,
      has_schema_privilege('app', 'public', 'CREATE') as schema_create,
      has_schema_privilege('app', 'public', 'USAGE') as schema_usage,
      has_database_privilege('app', current_database(), 'CREATE') as database_create,
      has_database_privilege('app', current_database(), 'TEMP') as database_temp,
      (select pg_get_userbyid(datdba) from pg_database where datname = current_database()) as database_owner,
      (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'public') as schema_owner
  `;
  if (!privileges || privileges.member || privileges.schema_create || !privileges.schema_usage ||
      privileges.database_create || privileges.database_temp || privileges.database_owner !== 'maintenance' ||
      privileges.schema_owner !== 'maintenance') failures.push('Unsafe database/schema privileges');
  const tables = await sql`
    select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner,
      exists(select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'gym_id' and not a.attisdropped) as has_gym,
      has_table_privilege('app', c.oid, 'SELECT') as can_select,
      has_table_privilege('app', c.oid, 'INSERT') as can_insert,
      has_table_privilege('app', c.oid, 'UPDATE') as can_update,
      has_table_privilege('app', c.oid, 'DELETE') as can_delete,
      has_table_privilege('app', c.oid, 'TRUNCATE') as can_truncate,
      has_table_privilege('app', c.oid, 'REFERENCES') as can_reference,
      has_table_privilege('app', c.oid, 'TRIGGER') as can_trigger
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') order by c.relname
  `;
  if (JSON.stringify(tables.map((t) => t.relname)) !== JSON.stringify(expectedTables)) failures.push('Unexpected or missing public tables');
  for (const table of tables) {
    const name = String(table.relname);
    const system = systemTables.some((entry) => entry.name === name);
    if (table.owner !== 'maintenance') failures.push(name + ': wrong owner');
    if (!table.has_gym && !system) failures.push(name + ': unregistered system table');
    const shape = await sql`
      select a.attname, a.attnotnull, format_type(a.atttypid, a.atttypmod) as type
      from pg_attribute a where a.attrelid = ${table.oid} and a.attnum > 0 and not a.attisdropped
    `;
    if (!system && !shape.some((column) => column.attname === 'gym_id' && column.type === 'uuid' && column.attnotnull)) failures.push(name + ': invalid gym_id');
    if (!shape.some((column) => column.attname === 'id' && column.type === 'uuid' && column.attnotnull)) failures.push(name + ': invalid UUID identity');
    if (shape.some((column) => column.type === 'timestamp without time zone')) failures.push(name + ': timestamp without timezone');
    const policies = await sql`
      select polcmd, polpermissive, pg_get_expr(polqual, polrelid) as using_expression,
        pg_get_expr(polwithcheck, polrelid) as check_expression,
        polroles = array[(select oid from pg_roles where rolname = 'app')] as app_only
      from pg_policy where polrelid = ${table.oid}
    `;
    if (system) {
      if (table.relrowsecurity || policies.length) failures.push(name + ': system inventory mismatch');
    } else {
      const policy = policies[0];
      if (!table.relrowsecurity || !table.relforcerowsecurity || policies.length !== 1 || !policy ||
          policy.polcmd !== '*' || !policy.polpermissive || !policy.app_only ||
          normalize(policy.using_expression ?? '') !== expectedPolicy ||
          normalize(policy.check_expression ?? '') !== expectedPolicy) failures.push(name + ': invalid forced gym policy');
    }
    const immutable = (appendOnlyTables as readonly string[]).includes(name);
    const attempt = name === 'payment_attempts';
    if (!table.can_select || !table.can_insert || table.can_truncate || table.can_reference || table.can_trigger ||
        table.can_update !== !(immutable || attempt) || table.can_delete !== !(immutable || attempt)) {
      failures.push(name + ': unexpected table privileges');
    }
    if (immutable || attempt) {
      const columns = await sql`
        select a.attname, has_column_privilege('app', a.attrelid, a.attname, 'UPDATE') as can_update
        from pg_attribute a where a.attrelid = ${table.oid} and a.attnum > 0 and not a.attisdropped
      `;
      for (const column of columns) {
        const expected = attempt && (mutableAttemptColumns as readonly string[]).includes(column.attname);
        if (column.can_update !== expected) failures.push(name + '.' + column.attname + ': unexpected UPDATE');
      }
    }
  }
  // FK enforcement bypasses RLS: both sides of every tenant relationship must carry gym_id.
  const foreignKeys = await sql`
    select c.conname,
      array(select a.attname from unnest(c.conkey) with ordinality k(num, pos)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.num order by k.pos) as source_columns,
      array(select a.attname from unnest(c.confkey) with ordinality k(num, pos)
        join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.num order by k.pos) as target_columns
    from pg_constraint c
    join pg_class source on source.oid = c.conrelid join pg_class target on target.oid = c.confrelid
    where c.contype = 'f' and source.relrowsecurity and target.relrowsecurity
  `;
  for (const fk of foreignKeys) if (fk.source_columns[0] !== 'gym_id' || fk.target_columns[0] !== 'gym_id') failures.push(fk.conname + ': unscoped foreign key');
  if (failures.length) throw new Error('Database catalog check failed:\n' + failures.join('\n'));
  return { tableCount: tables.length, tenantTableCount: tables.filter((t) => t.relrowsecurity).length };
}
