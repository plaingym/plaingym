// SPDX-License-Identifier: AGPL-3.0-only
import type { Sql } from '../client.js';

export async function privilegedMemberships(sql: Sql): Promise<string[]> {
  // Follow every membership edge, regardless of INHERIT, SET or ADMIN options.
  const roles = await sql<{ rolname: string }[]>`
    with recursive memberships(roleid) as (
      select m.roleid from pg_catalog.pg_auth_members m
      join pg_catalog.pg_roles r on r.oid = m.member where r.rolname = 'app'
      union
      select m.roleid from pg_catalog.pg_auth_members m join memberships on memberships.roleid = m.member
    )
    select r.rolname from memberships join pg_catalog.pg_roles r on r.oid = memberships.roleid
    where r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolreplication or r.rolcreatedb
      or r.rolname in ('maintenance', 'pg_execute_server_program', 'pg_write_server_files', 'pg_read_server_files',
        'pg_maintain', 'pg_signal_backend', 'pg_create_subscription', 'pg_checkpoint', 'pg_read_all_data',
        'pg_write_all_data', 'pg_read_all_stats', 'pg_monitor', 'pg_use_reserved_connections')
    order by r.rolname
  `;
  return roles.map(role => role.rolname);
}
