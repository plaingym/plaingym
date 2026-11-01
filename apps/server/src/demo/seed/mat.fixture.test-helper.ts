// SPDX-License-Identifier: AGPL-3.0-only
import type { DashboardWidget } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { authConfig } from '../../infra/auth/config.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { createAuthService } from '../../infra/auth/service.js';
import { createAttendanceQueries } from '../../areas/attendance/attendance.js';
import { createDashboardService } from '../../areas/dashboard/dashboard.js';
import { createMembersService } from '../../areas/members/members.js';
import { createPromotionCriteria } from '../../areas/ranks/criteria.js';
import { createRanksService } from '../../areas/ranks/ranks.service.js';
import { createGymDeleteService } from '../../areas/settings/gym-delete.js';
import { createDemoIdentities } from '../identities.js';
import { createDemoService } from '../service.js';
import { foundationSeed } from './foundation.js';
import { runSeeds } from './index.js';
import { membersSeed } from './members.js';
import { matSeed } from './mat.js';
import { pinKey } from './portal.fixture.test-helper.js';
import type { TestDatabase } from './seeded-database.test-helper.js';

export { pinKey };
export const day = 86_400_000;
const key = parseEncryptionKey('cd'.repeat(32));
const authentication = authConfig({ AUTH_SECRET: 'demo-seed-test-secret-with-more-than-32-characters', TENANCY: 'multi', AUTH_PASSWORD_LOGIN: 'off', NODE_ENV: 'production' }, true);

export const widget = <Id extends DashboardWidget['id']>(widgets: readonly DashboardWidget[], id: Id) => widgets.find((item) => item.id === id) as Extract<DashboardWidget, { id: Id }>;

/** The members and mat seeds (after the foundation step) and the demo service that runs them, over the file's database. */
export function matHarness(db: TestDatabase) {
  function fixture(time = new TestClock('2026-10-22T16:00:00Z')) {
    const scope = db.forGym;
    const steps = [foundationSeed({ scope, clock: time }), membersSeed({ scope, clock: time, pinSecret: async () => pinKey }), matSeed({ scope, clock: time })];
    const seed = (context: Parameters<typeof runSeeds>[0]) => runSeeds(context, steps);
    const identities = createDemoIdentities({ config: { enabled: true, domain: 'demo.example.test', maxSandboxes: 50 }, authConfig: authentication, clock: time,
      accounts: createAccountService(authentication, () => db.system.db), scope,
      authFactory: (options) => createAuthService({ ...options, database: () => db.system.db }) });
    const deletion = createGymDeleteService({ clock: time, scope, system: db.forSystem, removeUploads: async () => {} });
    const service = createDemoService({ config: { enabled: true, domain: 'demo.example.test', maxSandboxes: 50 }, key, clock: time, scope, system: db.forSystem, identities, seed, deletion });
    return { service, seed, time };
  }
  /** Row counts for every table with a gym_id, read in the gym's own context. */
  async function counts(gymId: string) {
    const tables = await db.app.sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'gym_id' order by table_name`;
    const result: Record<string, number> = {};
    await db.system.sql.begin(async (query) => {
      await query`select set_config('app.gym_id', ${gymId}, true)`;
      for (const table of tables) {
        const [row] = await query`select count(*)::int as total from ${query(String(table.table_name))} where gym_id = ${gymId}`;
        result[String(table.table_name)] = Number(row!.total);
      }
    });
    return result;
  }
  function dashboard(time: TestClock) {
    const scope = db.forGym, attendance = createAttendanceQueries({ scope });
    return createDashboardService({ members: createMembersService({ scope }), attendance,
      ranks: createRanksService({ scope, clock: time, criteria: createPromotionCriteria(attendance) }) });
  }
  return { fixture, counts, dashboard };
}
