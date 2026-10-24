// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { runInTransaction, assertNoTransaction } from '@plaingym/shared/transaction';
import { advisoryLockNamespace, advisoryLocks } from './locks.js';
import { householdQueries, type HouseholdScope } from './household.js';
export type Sql = ReturnType<typeof postgres>;
export type Database = PostgresJsDatabase;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Connection = ReturnType<typeof openConnection>;
/**
 * Raw infrastructure entry point. Feature code imports scoped helpers instead.
 * context 'system' sets app.system for every connection in the pool (the authentication adapter's pool).
 */
export function openConnection(url: string, max = 20, context?: 'system') {
  const client = postgres(url, { max, connect_timeout: 10, onnotice: () => undefined,
    ...(context === 'system' ? { connection: { 'app.system': 'on' } } : {}) });
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
  /**
   * One short transaction in system context, for system-table infrastructure only (lint-restricted):
   * tenancy lookup, job claiming, the webhook inbox, setup, restore. Never nests with a gym scope.
   */
  async function forSystem<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    assertNoTransaction('Nested database scope');
    return runInTransaction(() => db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.system', 'on', true)`);
      return fn(tx);
    }));
  }
  return { forGym, forHousehold, forSystem };
}
/**
 * Connections per use, budgeted against the shipped `max_connections` (`deploy/compose.yaml`) minus the slots
 * reserved for superusers. Queries beyond a pool's size wait in the pool instead of failing at the server.
 * A maintenance CLI snapshot (`update.sh` takes one before upgrading) can run beside the app's own backup.
 */
export const connectionBudget = {
  /** The app process's pool; `DATABASE_POOL_MAX` overrides it. */
  application: 8,
  /** The authentication adapter's system-context pool. */
  authentication: 2,
  /** The app's backup: the advisory-lock session and pg_dump (or pg_restore during a restore). */
  backup: 2,
  /** A maintenance CLI snapshot: one app and one system connection, the lock session, and pg_dump. */
  maintenanceCli: 4,
} as const;
let application: ReturnType<typeof scopedDatabase> | undefined;
let applicationConnection: Connection | undefined;
let systemConnection: Connection | undefined;
export async function initializeDatabase(url: string, max: number = connectionBudget.application,
  systemMax: number = connectionBudget.authentication) {
  if (applicationConnection) throw new Error('Database already initialized');
  for (const size of [max, systemMax]) if (!Number.isSafeInteger(size) || size < 1) throw new Error('Pool sizes must be positive integers');
  const connection = openConnection(url, max);
  const system = openConnection(url, systemMax, 'system');
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
    systemConnection = system;
    application = scopedDatabase(connection.db);
  } catch (error) { await connection.close(); await system.close(); throw error; }
}
export async function closeDatabase() {
  const connection = applicationConnection, system = systemConnection;
  application = undefined; applicationConnection = undefined; systemConnection = undefined;
  try { await connection?.close(); } finally { await system?.close(); }
}
function current() {
  if (!application) throw new Error('Initialize the database before serving requests');
  return application;
}
/**
 * The authentication adapter's handle: a separate two-connection app-role pool whose connections always
 * carry system context, because the adapter issues its own queries outside our transactions. Lint limits it to infra/auth.
 */
export function systemDatabase() {
  if (!systemConnection) throw new Error('Initialize the database before serving requests');
  return systemConnection.db;
}
export const forGym: ReturnType<typeof scopedDatabase>['forGym'] = (gymId, fn) => current().forGym(gymId, fn);
export const forHousehold: ReturnType<typeof scopedDatabase>['forHousehold'] = (scope, fn) => current().forHousehold(scope, fn);
export const forSystem: ReturnType<typeof scopedDatabase>['forSystem'] = (fn) => current().forSystem(fn);
/** A dedicated one-connection pool keeps the session advisory lock through Drizzle's migrations. */
export async function withMigrationConnection<T>(url: string, folder: string, after: (connection: Connection) => Promise<T>) {
  const connection = openConnection(url, 1);
  let locked = false;
  try {
    const [role] = await connection.sql`select current_user as name`;
    if (role?.name !== 'maintenance') throw new Error('Migrations require maintenance');
    await connection.sql`select pg_advisory_lock(${advisoryLockNamespace}::int, ${advisoryLocks.migrations}::int)`;
    locked = true;
    await migrate(connection.db, { migrationsFolder: folder });
    return await after(connection);
  } finally {
    try { if (locked) await connection.sql`select pg_advisory_unlock(${advisoryLockNamespace}::int, ${advisoryLocks.migrations}::int)`; }
    finally { await connection.close(); }
  }
}
