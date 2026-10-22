// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { runInTransaction, assertNoTransaction } from '@plaingym/shared/transaction';
import { householdQueries, type HouseholdScope } from './household.js';
export type Sql = ReturnType<typeof postgres>;
export type Database = PostgresJsDatabase;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Connection = ReturnType<typeof openConnection>;
/** Raw infrastructure entry point. Feature code imports scoped helpers instead. */
export function openConnection(url: string, max = 20) {
  const client = postgres(url, { max, connect_timeout: 10, onnotice: () => undefined });
  // No schema here: the relational tx.query API would reach every table, system tables included, without an import the lint can check.
  const db = drizzle(client);
  return { sql: client, db, close: () => client.end({ timeout: 5 }) };
}
export function validateUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Expected a UUID');
  }
}
export function scopedDatabase(db: Database) {
  async function forGym<T>(gymId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    validateUuid(gymId);
    assertNoTransaction('Nested database scope');
    return runInTransaction(() => db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.gym_id', ${gymId}, true)`);
      return fn(tx);
    }));
  }
  async function forHousehold<T>(scope: HouseholdScope, fn: (queries: Awaited<ReturnType<typeof householdQueries>>) => Promise<T>) {
    if (scope.kind === 'user') {
      validateUuid(scope.householdId);
      validateUuid(scope.userId);
    } else if (scope.kind === 'signed_link') {
      validateUuid(scope.linkId);
      if (!(scope.now instanceof Date) || !Number.isFinite(scope.now.getTime())) throw new Error('Household access denied');
    } else {
      throw new Error('Household access denied');
    }
    return forGym(scope.gymId, async (tx) => fn(await householdQueries(tx, scope)));
  }
  return { forGym, forHousehold };
}
let application: ReturnType<typeof scopedDatabase> | undefined;
let applicationConnection: Connection | undefined;
export async function initializeDatabase(url: string, max = 20) {
  if (applicationConnection) throw new Error('Database already initialized');
  const connection = openConnection(url, max);
  try {
    const [role] = await connection.sql`
      select current_user as name, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
        pg_has_role(current_user, 'maintenance', 'MEMBER') as maintenance_member
      from pg_roles where rolname = current_user
    `;
    if (!role || role.name !== 'app' || role.rolsuper || role.rolbypassrls || role.rolcreatedb || role.rolcreaterole || role.maintenance_member) {
      throw new Error('Application requires the restricted app database role');
    }
    applicationConnection = connection;
    application = scopedDatabase(connection.db);
  } catch (error) { await connection.close(); throw error; }
}
export async function closeDatabase() {
  const connection = applicationConnection;
  application = undefined; applicationConnection = undefined;
  await connection?.close();
}
function current() {
  if (!application) throw new Error('Initialize the database before serving requests');
  return application;
}
/** Only system-table infrastructure may use this unscoped, app-role handle. */
export function systemDatabase() {
  if (!applicationConnection) throw new Error('Initialize the database before serving requests');
  return applicationConnection.db;
}
export const forGym: ReturnType<typeof scopedDatabase>['forGym'] = (gymId, fn) => current().forGym(gymId, fn);
export const forHousehold: ReturnType<typeof scopedDatabase>['forHousehold'] = (scope, fn) => current().forHousehold(scope, fn);
/** A dedicated one-connection pool keeps the session advisory lock through Drizzle's migrations. */
export async function withMigrationConnection<T>(url: string, folder: string, after: (connection: Connection) => Promise<T>) {
  const connection = openConnection(url, 1);
  let locked = false;
  try {
    const [role] = await connection.sql`select current_user as name`;
    if (role?.name !== 'maintenance') throw new Error('Migrations require maintenance');
    await connection.sql`select pg_advisory_lock(1886151021, 1)`;
    locked = true;
    await migrate(connection.db, { migrationsFolder: folder });
    return await after(connection);
  } finally {
    try { if (locked) await connection.sql`select pg_advisory_unlock(1886151021, 1)`; }
    finally { await connection.close(); }
  }
}
