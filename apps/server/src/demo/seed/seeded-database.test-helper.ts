// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, afterEach, beforeAll, beforeEach, inject } from 'vitest';
import type { cloneDatabase } from '@plaingym/db/testing/database';
import type { useTestDatabase } from '@plaingym/db/testing/database';

type Clone = Awaited<ReturnType<typeof cloneDatabase>>;
export type TestDatabase = ReturnType<typeof useTestDatabase>;

/**
 * `useTestDatabase` for tests that all start from the same seeded state. `seed` fills one database in `beforeAll` (a
 * full sandbox seed takes seconds), and every test then gets its own copy of it, so a test may change what it likes and
 * the next one still starts from the seeded rows. Only the database is copied: anything `seed` keeps in memory
 * (clocks, payment fakes, upload fakes) is not, so tests that need it build it again and share what `seed` returns.
 * The test file passes `cloneDatabase` in, which is also what has Vitest start a PostgreSQL for the file.
 */
export function useSeededDatabase<Seeded>(clone: typeof cloneDatabase, seed: (database: TestDatabase) => Promise<Seeded>): TestDatabase & { readonly seeded: Seeded } {
  let template: Clone, copy: Clone | undefined, seeded: Seeded;
  const templateConfig = () => ({ ...inject('testDatabase'), template: template.name });
  beforeAll(async () => {
    template = await clone(inject('testDatabase'));
    seeded = await seed(accessors(() => template));
    // Postgres copies a database only while nothing is connected to it.
    await template.app.close(); await template.system.close();
  }, 90_000);
  beforeEach(async () => { copy = await clone(templateConfig()); });
  afterEach(async () => { const finished = copy; copy = undefined; await finished?.cleanup(); });
  afterAll(async () => { await template?.cleanup(); });
  // Not spread: the accessors are getters over the current copy.
  return Object.defineProperty(accessors(() => copy!), 'seeded', { get: () => seeded }) as TestDatabase & { readonly seeded: Seeded };
}
function accessors(current: () => Clone): TestDatabase {
  return {
    get app() { return current().app; },
    get system() { return current().system; },
    get name() { return current().name; },
    get maintenanceUrl() { return current().maintenanceUrl; },
    get appUrl() { return current().appUrl; },
    forGym: ((gymId, fn) => current().forGym(gymId, fn)) as TestDatabase['forGym'],
    forHousehold: ((scope, fn) => current().forHousehold(scope, fn)) as TestDatabase['forHousehold'],
    forSystem: ((fn) => current().forSystem(fn)) as TestDatabase['forSystem'],
  };
}
