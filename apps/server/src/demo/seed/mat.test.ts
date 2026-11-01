// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { attendances, classSessions, classTemplates, households, memberRanks, members, staffProfiles, staffRoles, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { verifyHouseholdPin } from '../../areas/members/pin.js';
import { demoHouseholds, demoPin, demoStaff } from './members.js';
import { demoTemplates, historyWeeks } from './mat.js';
import { day, matHarness, pinKey, widget } from './mat.fixture.test-helper.js';

const db = useTestDatabase();
const { fixture, dashboard } = matHarness(db);

// Each seed of a whole sandbox takes ~5–9 s alone, which can take several times longer under full-suite load. The
// retry and isolation test, which needs a second sandbox, is in `mat.retries.test.ts`.
describe('demo mat seed', { timeout: 60_000 }, () => {
  it('creates a lived-in sandbox in a few seconds through the area services', async () => {
    const f = fixture(), started = performance.now(), sandbox = await f.service.create(), elapsed = performance.now() - started;
    // A guard against gross regressions: alone a sandbox takes ~5 s, but full-suite load has taken it past 20 s.
    expect(elapsed).toBeLessThan(40_000);
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
    // A populated calendar: the history weeks behind and the 8-week horizon ahead (created with each template),
    // with one upcoming cancellation.
    expect(rows.sessions.filter((row) => row.startsAt.getTime() < now).length).toBe(historyWeeks * rows.templates.length);
    expect(rows.sessions.filter((row) => row.startsAt.getTime() >= now).length).toBe(8 * rows.templates.length);
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
  }, 90_000);

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
