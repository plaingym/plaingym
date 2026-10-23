// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { attendances, auditEvents, classSessions, classTemplates, emailOutbox, households, memberRanks, members, staffProfiles, staffRoles, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { DashboardWidget } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { authConfig } from '../../infra/auth/config.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { createAuthService } from '../../infra/auth/service.js';
import { createAttendanceQueries } from '../../areas/attendance/attendance.js';
import { createDashboardService } from '../../areas/dashboard/dashboard.js';
import { createMembersService } from '../../areas/members/members.js';
import { verifyHouseholdPin } from '../../areas/members/pin.js';
import { createPromotionCriteria } from '../../areas/ranks/criteria.js';
import { createRanksService } from '../../areas/ranks/ranks.service.js';
import { createGymDeleteService } from '../../areas/settings/gym-delete.js';
import { createDemoIdentities } from '../identities.js';
import { createDemoService } from '../service.js';
import { foundationSeed } from './foundation.js';
import { runSeeds } from './index.js';
import { demoHouseholds, demoPin, demoStaff, membersSeed } from './members.js';
import { demoTemplates, historyWeeks, matSeed } from './mat.js';

const db = useTestDatabase();
const key = parseEncryptionKey('cd'.repeat(32)), pinKey = new Uint8Array(32).fill(7);
const authentication = authConfig({ AUTH_SECRET: 'demo-seed-test-secret-with-more-than-32-characters', TENANCY: 'multi', AUTH_PASSWORD_LOGIN: 'off', NODE_ENV: 'production' }, true);
const day = 86_400_000;

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
const widget = <Id extends DashboardWidget['id']>(widgets: readonly DashboardWidget[], id: Id) => widgets.find((item) => item.id === id) as Extract<DashboardWidget, { id: Id }>;

// Each test seeds whole sandboxes (~5–9 s alone), which can take several times longer under full-suite load.
describe('demo mat seed', { timeout: 60_000 }, () => {
  it('creates a lived-in sandbox in a few seconds through the area services', async () => {
    const f = fixture(), started = performance.now();
    const sandbox = await f.service.create();
    // A guard against gross regressions: alone a sandbox takes ~5 s, but full-suite load has taken it past 20 s.
    expect(performance.now() - started).toBeLessThan(40_000);
    const now = f.time.now().getTime();
    const rows = await db.forGym(sandbox.gymId, async (tx) => ({
      members: await tx.select().from(members), households: await tx.select().from(households), roles: await tx.select().from(staffRoles),
      profiles: await tx.select().from(staffProfiles), templates: await tx.select().from(classTemplates), sessions: await tx.select().from(classSessions),
      visits: await tx.select().from(attendances), promotions: await tx.select().from(memberRanks),
    }));
    const seeded = demoHouseholds.flatMap((home) => home.members);
    // The demo student identity brings its own household and member.
    expect(rows.members).toHaveLength(seeded.length + 1);
    expect(rows.households).toHaveLength(demoHouseholds.length + 1);
    expect(rows.members.filter((row) => row.dateOfBirth && row.dateOfBirth > '2010-01-01').length).toBeGreaterThanOrEqual(6);
    for (const row of rows.households.filter((item) => item.name !== 'Demo student')) expect(verifyHouseholdPin(pinKey, sandbox.gymId, row.id, demoPin, row.pinHash)).toBe(true);
    expect(rows.profiles.map((row) => row.displayName).sort()).toEqual(demoStaff.map((row) => row.displayName).sort());
    const owner = rows.roles.find((row) => row.role === 'owner')!, coach = rows.roles.find((row) => row.role === 'coach')!;
    expect(rows.profiles.find((row) => row.displayName === 'Ana Ribeiro')?.userId).toBe(owner.userId);
    expect(rows.profiles.find((row) => row.displayName === 'Jordan Lee')?.userId).toBe(coach.userId);
    expect(rows.templates).toHaveLength(demoTemplates.reduce((total, item) => total + item.weekdays.length, 0));
    expect(rows.templates.every((row) => row.kind === 'open_mat' || row.coachId !== null)).toBe(true);
    // A populated calendar: the history weeks behind and as many ahead, with one upcoming cancellation.
    expect(rows.sessions.filter((row) => row.startsAt.getTime() < now).length).toBe(historyWeeks * rows.templates.length);
    expect(rows.sessions.filter((row) => row.startsAt.getTime() >= now).length).toBe(historyWeeks * rows.templates.length);
    expect(rows.sessions.filter((row) => row.status === 'cancelled')).toHaveLength(1);
    expect(rows.visits.filter((row) => row.occurredAt.getTime() > now - 2 * day).length).toBeGreaterThan(0);
    expect(rows.visits.some((row) => row.kind === 'open_mat')).toBe(true);
    expect(new Set(rows.visits.map((row) => row.source))).toEqual(new Set(['kiosk', 'coach']));
    expect(rows.promotions.length).toBeGreaterThan(30);

    const view = await dashboard(f.time).get({ gymId: sandbox.gymId, roles: ['owner'], clock: f.time });
    const named = (list: readonly { firstName: string; lastName: string }[]) => list.map((row) => `${row.firstName} ${row.lastName}`).sort();
    expect(named(widget(view.data.widgets, 'promotion_ready').members)).toEqual(['Ava Chen', 'Leo Becker', 'Marcus Rivera', 'Sofia Rivera', 'Tom Becker']);
    expect(named(widget(view.data.widgets, 'not_seen').members)).toEqual(["Grace O'Neill", 'Owen Murphy']);
    expect(widget(view.data.widgets, 'active_members').count).toBe(seeded.filter((row) => row.status === 'active').length + 1);
  });

  it('stays inside the sandbox gym, sends no email, writes no upload, and tolerates retries', async () => {
    const f = fixture(), other = await f.service.create(), before = await counts(other.gymId);
    const sandbox = await f.service.create();
    expect(await counts(other.gymId)).toEqual(before);
    const seeded = await counts(sandbox.gymId);
    expect(seeded.email_outbox).toBe(0);
    const photos = await db.forGym(sandbox.gymId, async (tx) => [...await tx.select({ key: members.photoKey }).from(members), ...await tx.select({ key: staffProfiles.photoKey }).from(staffProfiles)]);
    expect(photos.every((row) => row.key === null)).toBe(true);
    // Every audit names its own gym, and none of the other sandbox's rows moved.
    expect((await db.forGym(sandbox.gymId, (tx) => tx.select().from(auditEvents))).every((row) => row.gymId === sandbox.gymId)).toBe(true);

    // Rerunning the steps (as `gym-app seed` does) adds no duplicates, an hour later too.
    f.time.advance(60 * 60 * 1000);
    await f.seed({ gymId: sandbox.gymId, timezone: 'UTC', enabledModules: new Set() });
    const again = await counts(sandbox.gymId);
    for (const table of ['members', 'households', 'member_tags', 'member_tag_links', 'staff_profiles', 'class_templates', 'member_ranks', 'attendances'])
      expect(again[table], table).toBe(seeded[table]);
    expect(await db.forGym(sandbox.gymId, (tx) => tx.select().from(emailOutbox).where(eq(emailOutbox.gymId, sandbox.gymId)))).toEqual([]);
  });

  it('seeds an ordinary gym without staff accounts, leaving profiles and coaches out', async () => {
    const f = fixture(), gymId = uuidv7();
    await createFactories(db)('gyms', gymId, { timezone: 'America/New_York' });
    await f.seed({ gymId, timezone: 'America/New_York', enabledModules: new Set() });
    const rows = await db.forGym(gymId, async (tx) => ({ profiles: await tx.select().from(staffProfiles),
      templates: await tx.select().from(classTemplates), visits: await tx.select().from(attendances) }));
    expect(rows.profiles).toEqual([]);
    expect(rows.templates.every((row) => row.coachId === null)).toBe(true);
    expect(rows.visits.length).toBeGreaterThan(100);
    const view = await dashboard(f.time).get({ gymId, roles: ['owner'], clock: f.time });
    expect(widget(view.data.widgets, 'promotion_ready').count).toBe(5);
  });
});
