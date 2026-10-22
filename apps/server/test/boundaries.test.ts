// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { systemTables } from '../../../packages/db/system-tables.mjs';

const eslint = new ESLint({ cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
const area = 'apps/server/src/areas/members/service.ts';
const portal = 'apps/server/src/areas/portal/bookings.ts';
const links = 'apps/server/src/public/links/invoice.ts';
const core = 'apps/server/src/core/context.ts';

describe('system table access', () => {
  it.each(systemTables)('restricts $name to the declared modules', async (table) => {
    const source = `import { ${table.exportName} as table } from '@plaingym/db'; void table;`;
    for (const path of [area, portal, links, core]) {
      expect(await messages(path, source)).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: 'database/system-tables' }),
      ]));
    }
    for (const pattern of table.modules) {
      const path = 'apps/server/src/' + pattern.replace('[^/]*', '.ts').replace('.*', 'service.ts');
      expect(await messages(path, source)).toHaveLength(0);
    }
  });
  it.each([
    "import * as schema from '@plaingym/db/schema'; void schema.authUser;",
    "import * as schema from '@plaingym/db/schema'; void schema['jobs'];",
    "import * as schema from '@plaingym/db/schema'; const table = 'members'; void schema[table];",
    "import * as schema from '@plaingym/db/schema'; const { authSession } = schema; void authSession;",
    "export { backupRuns as records } from '@plaingym/db/schema/system';",
    "export * from '@plaingym/db/schema';",
    "import { stripeEvents } from '../../../../../packages/db/src/schema/system.js'; void stripeEvents;",
  ])('prevents system-table aliases and namespace bypasses: %s', async (source) => {
    expect(await messages(area, source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'database/system-tables' }),
    ]));
  });
  it('permits tenant table namespaces and query operators', async () => {
    expect(await messages(area, "import * as schema from '@plaingym/db/schema'; import { eq } from 'drizzle-orm'; void eq(schema.members.id, 'id');")).toHaveLength(0);
  });
  it('restricts migration and security imports', async () => {
    const source = "import { migrateDatabase } from '@plaingym/db/migrate'; void migrateDatabase;";
    expect(await messages(area, source)).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'database/system-tables' })]));
    expect(await messages('apps/server/src/core/database.ts', source)).toHaveLength(0);
    expect(await messages(core, "import { openConnection } from '@plaingym/db/client'; void openConnection;"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'database/system-tables' })]));
    expect(await messages('apps/server/src/core/tenancy.ts', "import { systemDatabase } from '@plaingym/db/client'; void systemDatabase;"))
      .toHaveLength(0);
  });
  const execute = "import { sql } from 'drizzle-orm'; declare const tx: { execute(query: unknown): unknown }; void tx.execute(sql`select * from gyms`);";
  const builder = "import { sql } from 'drizzle-orm'; declare const tx: { select(fields: unknown): { from(source: unknown): unknown } };"
    + " void tx.select({ config: sql<string>`stripe_config_encrypted` }).from(sql`gyms`);";
  const constructed = "import { SQL, StringChunk } from 'drizzle-orm'; declare const tx: { select(fields: unknown): { from(source: unknown): unknown } };"
    + " void tx.select({ config: new SQL([new StringChunk('stripe_config_encrypted')]) }).from(new SQL([new StringChunk('gyms')]));";
  it.each([
    execute,
    builder,
    "import { sql } from 'drizzle-orm'; void sql.raw('select 1');",
    "import { sql as text } from 'drizzle-orm'; void text;",
    "import { sql } from 'drizzle-orm/sql'; void sql;",
    "import * as orm from 'drizzle-orm'; void orm;",
    "export { sql } from 'drizzle-orm';",
    "export * from 'drizzle-orm';",
    "declare const tx: Record<string, (query: string) => unknown>; void tx['execute']('select 1');",
    'declare const tx: Record<string, (query: string) => unknown>; void tx[`execute`](\'select 1\');',
    "declare const tx: { execute(query: unknown): unknown }; const { execute: run } = tx; void run;",
    "declare const tx: { $client: unknown }; void tx.$client;",
    constructed,
    "import { SQL as Query, StringChunk as Text } from 'drizzle-orm'; void new Query([new Text('gyms')]);",
    "import { StringChunk } from 'drizzle-orm/sql'; void StringChunk;",
    "import { SQL } from 'drizzle-orm/sql/sql'; void SQL;",
    "import { name, placeholder } from 'drizzle-orm'; void [name, placeholder];",
    "import { pgTable, text } from 'drizzle-orm/pg-core'; void pgTable('gyms', { config: text('stripe_config_encrypted') });",
    "import { drizzle } from 'drizzle-orm/postgres-js'; void drizzle;",
    "import orm from 'drizzle-orm'; void orm;",
    "export { SQL } from 'drizzle-orm';",
    "void import('drizzle-orm').then((orm) => orm.SQL);",
    "declare const require: (id: string) => unknown; void require('drizzle-orm/sql');",
  ])('keeps raw SQL, which can name system tables without an import, in reviewed infrastructure: %s', async (source) => {
    for (const path of [area, portal, links, core]) {
      expect(await messages(path, source)).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'database/system-tables' })]));
    }
  });
  it('allows query-builder operators everywhere and raw SQL in reviewed infrastructure', async () => {
    expect(await messages(area, "import { and, eq } from 'drizzle-orm'; void and; void eq;")).toHaveLength(0);
    // Types carry no runtime constructor.
    expect(await messages(area, "import type { SQL } from 'drizzle-orm'; export type Expression = SQL;")).toHaveLength(0);
    expect(await messages(area, "import { type SQL, eq } from 'drizzle-orm'; export type Expression = SQL; void eq;")).toHaveLength(0);
    expect(await messages(area, "import type { PgColumn } from 'drizzle-orm/pg-core'; export type Column = PgColumn;")).toHaveLength(0);
    for (const path of ['apps/server/src/infra/jobs/worker.ts', 'apps/server/src/core/tenancy.ts', 'apps/server/src/areas/health/restore.ts']) {
      expect(await messages(path, execute)).toHaveLength(0);
      expect(await messages(path, builder)).toHaveLength(0);
      expect(await messages(path, constructed)).toHaveLength(0);
    }
  });
});

async function messages(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  expect(result).toBeDefined();
  expect(result?.messages.some((message) => message.fatal)).toBe(false);
  return result?.messages ?? [];
}

describe('dependency boundaries use the real ESLint configuration', () => {
  it.each([
    'better-auth', 'better-auth/react', '@better-auth/drizzle-adapter',
    'stripe', 'nodemailer', '@aws-sdk/client-s3', '@aws-sdk/client-s3/deep',
    '@smithy/smithy-client', 'pdfkit', 'fontkit', 'bidi-js', 'age-encryption',
  ])('rejects %s outside infra', async (dependency) => {
    expect(await messages(area, `import sdk from '${dependency}'; void sdk;`))
      .toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'no-restricted-imports' })]));
    expect(await messages('apps/server/src/infra/provider.ts', `import sdk from '${dependency}'; void sdk;`))
      .toHaveLength(0);
  });

  it.each([
    "import { eq, and } from 'drizzle-orm'; void [eq, and];",
    "import { members } from '@plaingym/db/schema/members'; void members;",
    "import { members } from '@plaingym/db'; void members;",
    "import { members } from '../../../../../packages/db/src/schema/members.js'; void members;",
    "import { forGym } from '@plaingym/db'; void forGym;",
  ])('allows normal area database code: %s', async (source) => {
    expect(await messages(area, source)).toHaveLength(0);
  });

  it.each([area, portal, links])('allows ordinary barrels and namespaces in %s', async (path) => {
    for (const source of [
      "export * from './members.routes.js';",
      "import * as service from './members.service.js'; void service;",
      "import * as schema from '@plaingym/db/schema'; void schema;",
      "import * as schema from '../../../../../packages/db/src/schema/index.js'; void schema;",
      "import { client } from '../../infra/payments/index.js'; void client;",
    ]) expect(await messages(path, source)).toHaveLength(0);
  });

  it.each(['apps/web/src/features/members.ts', 'packages/shared/src/contracts/members.ts'])('allows shared contract namespaces in %s', async (path) => {
      expect(await messages(path,
        "import * as contracts from '@plaingym/shared'; void contracts;"))
        .toHaveLength(0);
    });

  it.each(['apps/web/src/features/members.ts', 'apps/server/test/database.test.ts', 'apps/server/build.mjs'])('does not apply database restrictions outside server source: %s', async (path) => {
      for (const source of [
        "import { db } from '@plaingym/db'; void db;",
        "import postgres from 'postgres'; void postgres;",
        "import connection from '@plaingym/db/client'; void connection;",
      ]) expect(await messages(path, source)).toHaveLength(0);
    });

  it('allows query operators in core', async () => {
    expect(await messages(core, "import { eq } from 'drizzle-orm'; void eq;")).toHaveLength(0);
  });

  it.each([
    "import { db } from '@plaingym/db'; void db;",
    "import { client as connection } from '@plaingym/db/client'; void connection;",
    "import raw from '../../../../../packages/db/src/client.js'; void raw;",
    "import { connection } from '@plaingym/db/client'; void connection;",
    "import database from '@plaingym/db'; void database;",
    "import * as database from '@plaingym/db'; void database;",
    "export * from '@plaingym/db';",
    "export { db } from '@plaingym/db';",
    "import { db } from '../../../../../packages/db/src/index.js'; void db;",
    "import * as database from '../../../../../packages/db/src/index.js'; void database;",
    "import { db } from '@server/core/db'; void db;",
    "import postgres from 'postgres'; void postgres;",
    "import { drizzle } from 'drizzle-orm/postgres-js'; void drizzle;",
    "import { db } from '../../core/db.js'; void db;",
    "import { client as connection } from '../../core/db.js'; void connection;",
    "import { sql } from '../../core/db.js'; void sql;",
    "export { db as connection } from '../../core/db.js';",
    "import * as database from '../../core/db.js'; void database;",
    "import { db } from '../../core/database.js'; void db;",
  ])('rejects unscoped database access: %s', async (source) => {
    expect(await messages(area, source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'no-restricted-imports' }),
    ]));
  });

  it.each([portal, links])('%s permits only household access', async (path) => {
    for (const source of [
      "import { forGym as scope } from '@plaingym/db'; void scope;",
      "import { db } from '@plaingym/db'; void db;",
      "export { forGym } from '@plaingym/db/client';",
      "import { forGym } from '../../core/database.js'; void forGym;",
      "import { forGym } from '../../core/tenancy.js'; void forGym;",
      "import { forGym as scope } from '@server/core/context'; void scope;",
      "import * as db from '@plaingym/db'; void db;",
    ]) {
      expect(await messages(path, source)).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: 'no-restricted-imports' }),
      ]));
    }
    for (const source of [
      "import { forHousehold, members } from '@plaingym/db'; void [forHousehold, members];",
      "import { eq, and } from 'drizzle-orm'; void [eq, and];",
    ]) expect(await messages(path, source)).toHaveLength(0);
  });

  it.each(['../modules/website/routes.js', '@server/modules/website', '../../modules/website/index.js'])(
    'rejects core importing %s', async (dependency) => {
      expect(await messages(core, `export * from '${dependency}';`)).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: 'no-restricted-imports' }),
      ]));
    },
  );

  it('allows raw access in core/database infrastructure', async () => {
    for (const path of [core, 'apps/server/src/infra/jobs/worker.ts', 'packages/db/src/client.ts']) {
      expect(await messages(path, "import { db } from '@plaingym/db'; void db;")).toHaveLength(0);
    }
    expect(await messages('packages/db/src/client.ts', "import postgres from 'postgres'; void postgres;"))
      .toHaveLength(0);
  });

  it.each([
    "void import('stripe');",
    "const sdk = require('stripe'); void sdk;",
    "import { createRequire } from 'node:module'; createRequire(import.meta.url)('stripe');",
    "import { createRequire as loader } from 'module'; loader(import.meta.url)('stripe');",
    "import * as module from 'node:module'; module.createRequire(import.meta.url)('stripe');",
    "import module from 'node:module'; module.createRequire(import.meta.url)('stripe');",
  ])('rejects a server runtime loader bypass: %s', async (source) => {
    expect(await messages(area, source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'no-restricted-syntax' }),
    ]));
  });

  it.each([
    ['apps/web/src/routes/kiosk.tsx',
      "import { lazy } from 'react'; export const Kiosk = lazy(() => import('./kiosk'));"],
    ['apps/server/test/module.test.ts',
      "import { vi } from 'vitest'; vi.resetModules(); await import('../src/app.js');"],
    ['apps/server/src/core/app.test.ts',
      "import { vi } from 'vitest'; vi.resetModules(); await import('./app.js');"],
    ['apps/server/src/core/__tests__/app.ts',
      "import { vi } from 'vitest'; vi.resetModules(); await import('../app.js');"],
    ['apps/server/test/require.test.ts', "const fixture = require('./fixture.cjs'); void fixture;"],
    ['apps/server/build.mjs',
      "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); require('node:net');"],
  ])('allows lazy imports and loaders in %s', async (path, source) => {
    expect(await messages(path, source)).toHaveLength(0);
  });

  it('provides Node globals in tooling and browser globals in the web app', async () => {
    expect(await messages('apps/server/build.mjs',
      "setTimeout(() => { void fetch('https://example.invalid'); }, 0);")).toHaveLength(0);
    expect(await messages('apps/web/src/browser.js', "document.title = window.location.hostname;"))
      .toHaveLength(0);
  });
});
