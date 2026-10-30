// SPDX-License-Identifier: AGPL-3.0-only
import { forGym } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { ClassKind, ClassSession, Program } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { createAttendanceQueries, createAttendanceService } from '../../areas/attendance/attendance.js';
import { createMembersService } from '../../areas/members/members.js';
import { createPromotionCriteria } from '../../areas/ranks/criteria.js';
import { createRanksService } from '../../areas/ranks/ranks.service.js';
import { createScheduleService } from '../../areas/schedule/schedule.js';
import { createStaffProfileService } from '../../areas/staff/profiles.js';
import { day, findDemoMembers, inBatches, settableClock } from './members.js';
import type { SeedStep } from './index.js';

type Track = 'adult' | 'kids';
/** Sessions and attendance history cover four whole weeks before the seed runs. Materializing from
 * that point creates eight weeks of sessions, four of them ahead; the nightly job extends the rest. */
export const historyWeeks = 4;
const week = 7 * day, page = { limit: 100, offset: 0 } as const;
/** Programs and class tags come from the sample content pack applied by the foundation step. */
const programNames: Readonly<Record<Track, string>> = { adult: 'BJJ All Levels', kids: 'Kids BJJ' };
/** Applied only to ranks that still have no criteria; the gym can edit them like any other. */
const targets: Readonly<Record<Track, (position: number) => { classes: number; days: number }>> = {
  adult: (position) => ({ classes: 12 * (position + 1), days: 45 * (position + 1) }),
  kids: () => ({ classes: 10, days: 60 }),
};
interface DemoTemplate {
  readonly name: string; readonly weekdays: readonly number[]; readonly time: string; readonly minutes: number; readonly track: Track;
  readonly tags: readonly string[]; readonly coach: string | null; readonly capacity: number | null; readonly kind: ClassKind;
}
const template = (name: string, weekdays: readonly number[], time: string, minutes: number, track: Track, tags: readonly string[],
  coach: string | null, extra: Partial<DemoTemplate> = {}): DemoTemplate => ({ name, weekdays, time, minutes, track, tags, coach, capacity: null, kind: 'class', ...extra });
/** Sunday is 0. Eleven adult classes, three kids classes, and a Saturday open mat each week. */
export const demoTemplates: readonly DemoTemplate[] = [
  template('Fundamentals', [1, 3, 5], '06:30', 60, 'adult', ['Gi'], 'Jordan Lee', { capacity: 24 }),
  template('No-Gi All Levels', [1, 3], '12:00', 60, 'adult', ['No-Gi'], 'Sam Okafor'),
  template('Gi All Levels', [1, 2, 3, 4], '18:00', 75, 'adult', ['Gi'], 'Ana Ribeiro', { capacity: 30 }),
  template('Competition Training', [2, 4], '19:30', 60, 'adult', ['Competition Training', 'No-Gi'], 'Sam Okafor'),
  template('Kids BJJ', [2, 4], '17:00', 45, 'kids', ['Gi'], 'Priya Nair', { capacity: 20 }),
  template('Kids BJJ', [6], '09:00', 45, 'kids', ['Gi'], 'Priya Nair', { capacity: 20 }),
  template('Open Mat', [6], '10:30', 120, 'adult', ['Open Mat'], null, { kind: 'open_mat' }),
];
interface MatProfile {
  readonly track: Track; readonly perWeek: number; readonly lastSeenDaysAgo?: number; readonly openMat?: boolean;
  /** Rank name, sub-rank, and days ago, oldest first. */
  readonly promotions: readonly (readonly [string, number, number])[];
}
/** Promotion-ready with the criteria above: Marcus, Sofia, Tom, Ava, and Leo. Grace and Owen haven't been seen for 14+ days. */
export const matProfiles: Readonly<Record<string, MatProfile>> = {
  'Marcus Rivera': { track: 'adult', perWeek: 7, openMat: true, promotions: [['White belt', 0, 900], ['Blue belt', 0, 500], ['Blue belt', 1, 300], ['Blue belt', 2, 120]] },
  'Sofia Rivera': { track: 'adult', perWeek: 4, promotions: [['White belt', 0, 300], ['White belt', 1, 220], ['White belt', 2, 150], ['White belt', 3, 70]] },
  'Mateo Rivera': { track: 'kids', perWeek: 3, promotions: [['White belt', 0, 400], ['Grey and white belt', 0, 200], ['Grey belt', 0, 30]] },
  'Lucia Rivera': { track: 'kids', perWeek: 2, promotions: [['White belt', 0, 150]] },
  'Daniel Chen': { track: 'adult', perWeek: 3, promotions: [['White belt', 0, 60], ['White belt', 1, 20]] },
  'Ava Chen': { track: 'kids', perWeek: 3, promotions: [['White belt', 0, 500], ['Grey and white belt', 0, 300], ['Grey belt', 0, 100]] },
  'Aisha Khan': { track: 'adult', perWeek: 2, openMat: true, promotions: [['White belt', 0, 1100], ['Blue belt', 0, 800], ['Purple belt', 0, 400], ['Purple belt', 1, 200]] },
  'Zoe Khan': { track: 'kids', perWeek: 2, promotions: [] },
  'Tom Becker': { track: 'adult', perWeek: 4, promotions: [['White belt', 0, 200], ['White belt', 1, 160], ['White belt', 2, 90]] },
  'Leo Becker': { track: 'kids', perWeek: 3, promotions: [['White belt', 0, 250]] },
  'Tobi Adeyemi': { track: 'adult', perWeek: 5, openMat: true, promotions: [['White belt', 0, 500], ['Blue belt', 0, 300], ['Blue belt', 1, 150], ['Blue belt', 2, 50]] },
  'Kemi Adeyemi': { track: 'kids', perWeek: 3, promotions: [['White belt', 0, 300], ['Grey and white belt', 0, 200], ['Grey belt', 0, 120], ['Grey and black belt', 0, 40]] },
  'Elena Petrova': { track: 'adult', perWeek: 1, openMat: true, promotions: [['White belt', 0, 1500], ['Blue belt', 0, 1200], ['Purple belt', 0, 800], ['Brown belt', 0, 400], ['Brown belt', 1, 200]] },
  'Kenji Watanabe': { track: 'adult', perWeek: 4, promotions: [['White belt', 0, 400], ['White belt', 2, 250], ['Blue belt', 0, 60]] },
  "Grace O'Neill": { track: 'adult', perWeek: 2, lastSeenDaysAgo: 20, promotions: [['White belt', 0, 180], ['White belt', 1, 120], ['White belt', 2, 75]] },
  'Owen Murphy': { track: 'adult', perWeek: 1, lastSeenDaysAgo: 24, promotions: [['White belt', 0, 220], ['White belt', 1, 100]] },
  'Bruno Silva': { track: 'adult', perWeek: 3, promotions: [['White belt', 0, 30]] },
  'Luis Ortega': { track: 'adult', perWeek: 0, promotions: [['White belt', 0, 700], ['Blue belt', 0, 400]] },
  'Hannah Schmidt': { track: 'adult', perWeek: 2, promotions: [] },
  'Marta Novak': { track: 'adult', perWeek: 0, promotions: [['White belt', 0, 800], ['White belt', 1, 600]] },
};
/** Stable choice of classes, so a seed with the same clock produces the same history. */
function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 0x01000193) >>> 0;
  return result;
}

export function matSeed(options: { scope?: typeof forGym; clock?: Clock } = {}): SeedStep {
  const scope = options.scope ?? forGym;
  return { id: 'mat', async run(context) {
    const now = (options.clock ?? defaultClock).now(), fixed = { now: () => new Date(now) }, gymId = context.gymId;
    const actor: MutationContext = { gymId, actor: { kind: 'system' } };
    const ranks = createRanksService({ scope, clock: fixed, criteria: createPromotionCriteria(createAttendanceQueries({ scope })) });
    const schedule = createScheduleService({ scope, clock: fixed });
    const programs = (await ranks.listPrograms(gymId, page)).data;
    const program = (track: Track): Program & { rankSystemId: string } => {
      const found = programs.find((row) => row.name === programNames[track]);
      if (!found?.rankSystemId) throw new Error(`Demo seed requires the "${programNames[track]}" program`);
      return { ...found, rankSystemId: found.rankSystemId };
    };
    const rankLists = new Map<string, Awaited<ReturnType<typeof ranks.listRanks>>['data']>();
    for (const track of ['adult', 'kids'] as const) {
      const system = program(track).rankSystemId;
      if (rankLists.has(system)) continue;
      const list = (await ranks.listRanks(gymId, { ...page, rankSystemId: system })).data;
      for (const rank of list) {
        if (rank.criteria.length) continue;
        const target = targets[track](rank.position);
        Object.assign(rank, await ranks.updateRank(actor, rank.id, { revision: rank.revision, criteria: [
          { providerId: 'classes-since-promotion', config: { target: target.classes } }, { providerId: 'time-at-rank', config: { target: target.days } }] }));
      }
      rankLists.set(system, list);
    }

    const coaches = new Map((await createStaffProfileService(scope).listProfiles(gymId, page)).data.map((row) => [row.displayName, row.id]));
    const tags = new Map((await schedule.listTags(gymId, page)).data.map((row) => [row.name, row.id]));
    const existing = (await schedule.listTemplates(gymId, page)).data;
    for (const item of demoTemplates) for (const weekday of item.weekdays) {
      if (existing.some((row) => row.name === item.name && row.weekday === weekday && row.localStartTime === item.time)) continue;
      await schedule.createTemplate(actor, { name: item.name, weekday, localStartTime: item.time, durationMinutes: item.minutes,
        coachId: (item.coach && coaches.get(item.coach)) || null, capacity: item.capacity, notes: null, kind: item.kind,
        programIds: [program(item.track).id], tagIds: item.tags.flatMap((name) => tags.get(name) ?? []) });
    }
    // Materializing from a past clock generates the history through the same job code as future sessions.
    const start = now.getTime() - historyWeeks * week;
    await schedule.materialize(gymId, context.timezone, { now: () => new Date(start) });
    const sessions = await sessionsBetween(schedule, gymId, new Date(start), new Date(now.getTime() + 14 * day));
    const upcoming = sessions.filter((row) => row.name === 'Competition Training' && Date.parse(row.startsAt) > now.getTime());
    if (upcoming.length && !upcoming.some((row) => row.status === 'cancelled'))
      await schedule.changeSession(actor, upcoming[0]!.id, 'cancel', { revision: upcoming[0]!.revision });

    const members = await findDemoMembers(createMembersService({ scope }), gymId);
    const roster = Object.entries(matProfiles).flatMap(([name, profile]) => {
      const member = members.get(name);
      return member ? [{ name, profile, member, track: program(profile.track) }] : [];
    });
    await inBatches(roster, async ({ member, profile, track }) => {
      const done = new Set((await ranks.listPromotions(gymId, { ...page, memberId: member.id, programId: track.id })).data.map((row) => `${row.rankId}:${row.subRank}`));
      for (const [rankName, subRank, daysAgo] of profile.promotions) {
        const rank = rankLists.get(track.rankSystemId)!.find((row) => row.name === rankName);
        if (!rank) throw new Error(`Demo seed requires the "${rankName}" rank`);
        if (done.has(`${rank.id}:${subRank}`)) continue;
        await ranks.promote(actor, { memberId: member.id, programId: track.id, rankId: rank.id, rankSystemId: track.rankSystemId,
          subRank, promotedAt: new Date(now.getTime() - daysAgo * day).toISOString() });
      }
    });

    const names = new Set(demoTemplates.map((item) => item.name));
    const past = sessions.filter((row) => names.has(row.name) && row.status === 'scheduled' && Date.parse(row.startsAt) < now.getTime());
    await inBatches(roster, async ({ name, profile, member, track }) => {
      // Each visit is recorded at its check-in time, so attendance rows and audits carry history dates.
      const at = settableClock(now), attendance = createAttendanceService({ scope, clock: at });
      // Weeks shift with the clock, so a rerun leaves members who already have history alone.
      if ((await attendance.list(gymId, { memberId: member.id, limit: 1, offset: 0 })).pagination.total) return;
      const from = Date.parse(member.createdAt), until = now.getTime() - (profile.lastSeenDaysAgo ?? 0) * day;
      const open = (row: ClassSession) => Date.parse(row.startsAt) >= from && Date.parse(row.startsAt) <= until && row.programIds.includes(track.id);
      const weeks = new Map<number, ClassSession[]>();
      for (const row of past.filter((item) => open(item) && item.kind === 'class')) {
        const index = Math.floor((now.getTime() - Date.parse(row.startsAt)) / week);
        weeks.set(index, [...weeks.get(index) ?? [], row]);
      }
      const visits = [...weeks.values()].flatMap((rows) => rows.sort((a, b) => hash(name + a.startsAt + a.name) - hash(name + b.startsAt + b.name)).slice(0, profile.perWeek));
      if (profile.openMat) visits.push(...past.filter((item) => open(item) && item.kind === 'open_mat'));
      for (const session of visits) {
        const seed = hash(name + session.startsAt + session.name);
        at.set(Date.parse(session.startsAt) - (seed % 600_000));
        await attendance.record({ gymId, actor: { kind: 'system' } }, { memberId: member.id, sessionId: session.id, programId: null,
          occurredAt: at.now().toISOString() }, { source: seed % 3 ? 'kiosk' : 'coach' });
      }
    });
  } };
}
export async function sessionsBetween(schedule: ReturnType<typeof createScheduleService>, gymId: string, from: Date, until: Date) {
  const rows: ClassSession[] = [];
  for (let offset = 0; ; offset += 100) {
    const result = await schedule.listSessions(gymId, { limit: 100, offset, from: from.toISOString(), until: until.toISOString() });
    rows.push(...result.data);
    if (offset + 100 >= result.pagination.total) return rows;
  }
}
export const seeds: readonly SeedStep[] = [matSeed()];
