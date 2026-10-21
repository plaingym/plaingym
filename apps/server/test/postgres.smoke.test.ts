// SPDX-License-Identifier: AGPL-3.0-only
// TODO(CCR): replace this test-only connection with packages/db's isolated test helper.
import postgres from 'postgres';
import { expect, inject, it } from 'vitest';

it('connects as app and verifies bootstrap roles, ownership and DML-only defaults', async () => {
  const url = inject('databaseUrl');
  const sql = postgres(url, { max: 1, connect_timeout: 10 });
  try {
    const [appRole] = await sql`
      SELECT current_user AS name, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
             rolreplication, rolcanlogin,
             pg_has_role(current_user, 'maintenance', 'MEMBER') AS maintenance_member,
             has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
             has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
             has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
             has_database_privilege(current_user, current_database(), 'TEMP') AS database_temp
      FROM pg_roles WHERE rolname = current_user
    `;
    expect(appRole).toEqual({
      name: 'app', rolsuper: false, rolbypassrls: false, rolcreatedb: false,
      rolcreaterole: false, rolreplication: false, rolcanlogin: true,
      maintenance_member: false, schema_create: false, schema_usage: true,
      database_create: false, database_temp: false,
    });
    const [maintenance] = await sql`
      SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin,
             (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) AS database_owner,
             (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') AS schema_owner
      FROM pg_roles WHERE rolname = 'maintenance'
    `;
    expect(maintenance).toEqual({
      rolsuper: false, rolbypassrls: true, rolcreatedb: false, rolcreaterole: false,
      rolcanlogin: true, database_owner: 'maintenance', schema_owner: 'maintenance',
    });
    const privileges = await sql`
      SELECT acl.privilege_type
      FROM pg_default_acl defaults
      JOIN pg_roles owner ON owner.oid = defaults.defaclrole
      JOIN pg_namespace namespace ON namespace.oid = defaults.defaclnamespace
      CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
      WHERE owner.rolname = 'maintenance' AND namespace.nspname = 'public'
        AND defaults.defaclobjtype = 'r'
        AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'app')
      ORDER BY acl.privilege_type
    `;
    expect(privileges.map((row) => row.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
