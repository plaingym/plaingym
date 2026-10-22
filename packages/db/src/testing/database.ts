// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, inject } from 'vitest';
import { openConnection, scopedDatabase, type Connection } from '../client.js';
import { migrateDatabase } from '../migrate.js';
import { assertCatalog } from '../security/catalog.js';
export interface TestDatabaseConfig { appUrl: string; maintenanceUrl: string; adminUrl: string; template: string }
declare module 'vitest' {
  export interface ProvidedContext { testDatabase: TestDatabaseConfig }
}
export function databaseUrl(url: string, name: string) {
  const result = new URL(url); result.pathname = '/' + name; return result.toString();
}
async function restrictDatabase(connection: Connection, name: string) {
  const sql = connection.sql;
  await sql`revoke all on database ${sql(name)} from public`;
  await sql`grant connect on database ${sql(name)} to app`;
}
export async function prepareTemplate(urls: Omit<TestDatabaseConfig, 'template'>) {
  const template = 'plaingym_template_' + randomUUID().replaceAll('-', '');
  const admin = openConnection(databaseUrl(urls.adminUrl, 'postgres'), 1);
  let created = false;
  try {
    await admin.sql`create database ${admin.sql(template)} owner maintenance template template0`;
    created = true;
    await restrictDatabase(admin, template);
    const maintenance = openConnection(databaseUrl(urls.maintenanceUrl, template), 1);
    try {
      await maintenance.sql`alter schema public owner to maintenance`;
      await maintenance.sql`revoke all on schema public from public`;
      await maintenance.sql`grant usage on schema public to app`;
      await maintenance.sql`alter default privileges for role maintenance in schema public grant select, insert, update, delete on tables to app`;
    } finally { await maintenance.close(); }
    await migrateDatabase(databaseUrl(urls.maintenanceUrl, template));
    const check = openConnection(databaseUrl(urls.appUrl, template), 1);
    try { await assertCatalog(check.sql); } finally { await check.close(); }
    await admin.sql`alter database ${admin.sql(template)} allow_connections false`;
    return {
      config: { ...urls, template },
      cleanup: async () => {
        const cleanup = openConnection(databaseUrl(urls.adminUrl, 'postgres'), 1);
        try { await cleanup.sql`drop database ${cleanup.sql(template)} with (force)`; }
        finally { await cleanup.close(); }
      },
    };
  } catch (error) {
    if (created) await admin.sql`drop database ${admin.sql(template)} with (force)`;
    throw error;
  } finally { await admin.close(); }
}
export async function cloneDatabase(config: TestDatabaseConfig) {
  const name = 'plaingym_test_' + randomUUID().replaceAll('-', '');
  const admin = openConnection(databaseUrl(config.adminUrl, 'postgres'), 1);
  let created = false;
  try {
    await admin.sql`create database ${admin.sql(name)} owner maintenance template ${admin.sql(config.template)}`;
    created = true;
    await restrictDatabase(admin, name);
  } catch (error) {
    if (created) await admin.sql`drop database ${admin.sql(name)} with (force)`;
    throw error;
  } finally { await admin.close(); }
  const app = openConnection(databaseUrl(config.appUrl, name), 2);
  return {
    name, app, ...scopedDatabase(app.db),
    maintenanceUrl: databaseUrl(config.maintenanceUrl, name),
    appUrl: databaseUrl(config.appUrl, name),
    cleanup: async () => {
      await app.close();
      const cleanup = openConnection(databaseUrl(config.adminUrl, 'postgres'), 1);
      try { await cleanup.sql`drop database ${cleanup.sql(name)} with (force)`; }
      finally { await cleanup.close(); }
    },
  };
}
/** Call once at module scope in each integration test file. */
export function useTestDatabase() {
  let database: Awaited<ReturnType<typeof cloneDatabase>>;
  beforeAll(async () => { database = await cloneDatabase(inject('testDatabase')); });
  afterAll(async () => { await database?.cleanup(); });
  return {
    get app() { return database.app; },
    get name() { return database.name; },
    get maintenanceUrl() { return database.maintenanceUrl; },
    get appUrl() { return database.appUrl; },
    forGym: ((gymId, fn) => database.forGym(gymId, fn)) as ReturnType<typeof scopedDatabase>['forGym'],
    forHousehold: ((scope, fn) => database.forHousehold(scope, fn)) as ReturnType<typeof scopedDatabase>['forHousehold'],
  };
}
