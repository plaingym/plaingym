// SPDX-License-Identifier: AGPL-3.0-only
// Every bounded portal read against a direct query of the whole collection, on a household of 1,000 bookings and 500 invoices.
import '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { attendances, classBookings, classSessionPrograms, classSessions, classSessionTags, invoices, memberRanks, memberships,
  uuidv7, waiverSignatures } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError } from '@plaingym/shared';
import { TestClock } from '../../core/clock.js';
import type { PortalIdentity } from '../../core/interfaces/member-household.js';
import { createAttendanceQueries } from '../attendance/attendance.js';
import { createBookingService } from '../bookings/bookings.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { createPromotionCriteria } from '../ranks/criteria.js';
import { createRanksService } from '../ranks/ranks.service.js';
import { createScheduleService } from '../schedule/schedule.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createPortalBillingService } from './billing.js';
import { createPortalBookingService } from './bookings.js';
import { createPortalHouseholdService } from './household.js';
import { createPortalProgressService } from './progress.js';
import { createPortalScheduleService } from './schedule.js';
import { createPortalWaiverService } from './waivers.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-10-29T16:00:00Z');
const gymId = uuidv7(), base = Date.parse('2026-01-01T00:00:00Z'), minute = 60_000;
const hash = 'a'.repeat(64), page = { limit: 20, offset: 40 };
let numbers = 0;

/** A payer, a child and an adult with their own login, with `size` bookings and attendances and `size / 2` invoices between them. */
async function household(size: number) {
  const home = await factory('households', gymId), payerUser = await factory('authUser', gymId), adultUser = await factory('authUser', gymId);
  const payer = await factory('members', gymId, { householdId: home.id, firstName: 'Pat', lastName: 'Payer', dateOfBirth: '1980-04-02' });
  const child = await factory('members', gymId, { householdId: home.id, firstName: 'Kim', lastName: 'Payer', dateOfBirth: '2016-06-01' });
  const adult = await factory('members', gymId, { householdId: home.id, firstName: 'Alex', lastName: 'Payer', dateOfBirth: '1990-01-01' });
  await factory('householdUsers', gymId, { householdId: home.id, userId: payerUser.id, memberId: payer.id, scope: 'payer' });
  await factory('householdUsers', gymId, { householdId: home.id, userId: adultUser.id, memberId: adult.id, scope: 'member' });
  const owner = (i: number) => i % 4 === 3 ? adult.id : child.id;
  const sessions = Array.from({ length: size }, (_, i) => ({ id: uuidv7(), gymId, name: 'Class ' + i,
    startsAt: new Date(base + i * 60 * minute), endsAt: new Date(base + (i + 1) * 60 * minute) }));
  await db.forGym(gymId, async tx => {
    await tx.insert(classSessions).values(sessions);
    await tx.insert(classSessionPrograms).values(sessions.map((row, i) => ({ id: uuidv7(), gymId, sessionId: row.id, programId: i % 5 === 0 ? program : ranked })));
    await tx.insert(classSessionTags).values(sessions.filter((_, i) => i % 3 === 0).map(row => ({ id: uuidv7(), gymId, sessionId: row.id, tagId: tag })));
    // Runs of three share a timestamp, so every order is decided by its tie-breakers too.
    await tx.insert(classBookings).values(sessions.map((row, i) => ({ id: uuidv7(), gymId, memberId: owner(i), sessionId: row.id,
      status: i % 7 === 6 ? 'waitlisted' : i % 5 === 4 ? 'cancelled' : 'booked', waitlistPosition: i % 7 === 6 ? 1 : null,
      cancelledAt: i % 7 !== 6 && i % 5 === 4 ? new Date(base) : null, bookedBy: payerUser.id, bookedByKind: 'member',
      createdAt: new Date(base + Math.floor(i / 3) * minute) })));
    await tx.insert(attendances).values(sessions.map((row, i) => ({ id: uuidv7(), gymId, memberId: owner(i), sessionId: i % 2 ? row.id : null,
      programId: i % 11 === 0 ? program : null, occurredAt: new Date(base + Math.floor(i / 3) * minute), source: 'coach', kind: i % 6 === 5 ? 'open_mat' : 'class' })));
    await tx.insert(invoices).values(Array.from({ length: size / 2 }, (_, i) => {
      const status = ['open', 'paid', 'past_due', 'draft', 'void'][i % 5]!;
      return { id: uuidv7(), gymId, householdId: home.id, kind: 'one_off', status, number: status === 'draft' ? null : ++numbers,
        dueOn: new Date(base + Math.floor(i / 3) * 86_400_000).toISOString().slice(0, 10), amountCents: 1000 + i, currency: 'USD',
        paidAt: status === 'paid' ? new Date(base) : null };
    }));
    await tx.insert(memberRanks).values(Array.from({ length: 6 }, (_, i) => ({ id: uuidv7(), gymId, memberId: child.id, programId: ranked,
      rankId: rank, rankSystemId: system, subRank: i, promotedAt: new Date(base + i * minute) })));
    await tx.insert(waiverSignatures).values(Array.from({ length: size / 10 }, (_, i) => ({ id: uuidv7(), gymId, memberId: owner(i),
      templateId: templates[i % 2]!, snapshot: '{}', snapshotHash: hash, signatureImageKey: 'k', signatureImageHash: hash,
      signedAt: new Date(base + Math.floor(i / 3) * minute), ipAddress: '127.0.0.1' })));
  });
  const plan = await factory('plans', gymId);
  for (let i = 0; i < 12; i++) await factory('memberships', gymId, { householdId: home.id, memberId: owner(i), planId: plan.id,
    startsOn: `2026-0${1 + i % 3}-01`, status: 'cancelled' });
  const identity: PortalIdentity = { gymId, householdId: home.id, userId: payerUser.id };
  return { identity, adultIdentity: { ...identity, userId: adultUser.id }, payer, child, adult };
}
let program: string, ranked: string, rank: string, system: string, tag: string, templates: string[];
let large: Awaited<ReturnType<typeof household>>, small: Awaited<ReturnType<typeof household>>;
beforeAll(async () => {
  await factory('gyms', gymId);
  program = (await factory('programs', gymId, { name: 'Core' })).id;
  system = (await factory('rankSystems', gymId)).id;
  ranked = (await factory('programs', gymId, { name: 'Ranked', rankSystemId: system })).id;
  rank = (await factory('ranks', gymId, { rankSystemId: system, name: 'First', position: 0, subRanks: Array.from({ length: 8 }, (_, i) => ({ id: 's' + i, name: 'S' + i })),
    criteria: [{ providerId: 'classes-since-promotion', config: { target: 2 } }] })).id;
  tag = (await factory('classTags', gymId)).id;
  templates = [(await factory('waiverTemplates', gymId, { name: 'Alpha' })).id, (await factory('waiverTemplates', gymId, { name: 'Beta' })).id,
    (await factory('waiverTemplates', gymId, { name: 'Gamma' })).id];
  large = await household(1000);
  small = await household(100);
}, 120_000);

type HouseholdScope = typeof db.forHousehold;
/** Counts each read through the household boundary and the rows it hands back to the app. */
function counting() {
  const seen = { queries: 0, rows: 0 };
  const scope: HouseholdScope = (grant, fn) => db.forHousehold(grant, queries => fn(new Proxy(queries, { get(target, key) {
    const method = target[key as keyof typeof target] as (...args: unknown[]) => Promise<unknown>;
    return async (...args: unknown[]) => {
      const result = await method(...args);
      seen.queries += 1;
      seen.rows += Array.isArray(result) ? result.length : (result as { rows?: unknown[] } | null)?.rows?.length ?? 1;
      return result;
    };
  } })));
  return { seen, scope };
}
function services(householdScope: HouseholdScope) {
  const households = createMemberHouseholdContext(db.forGym), settings = createGymSettingsAccessor({ scope: db.forGym });
  const shared = { households, householdScope }, bookings = createBookingService({ scope: db.forGym, clock, settings });
  const attendance = createAttendanceQueries({ scope: db.forGym, householdScope, clock, settings });
  const ranks = createRanksService({ scope: db.forGym, clock, criteria: createPromotionCriteria(attendance), settings });
  const unused = () => { throw new Error('Not used by reads'); };
  return { attendance,
    bookings: createPortalBookingService({ ...shared, bookings }),
    schedule: createPortalScheduleService({ ...shared, bookings, settings, schedule: createScheduleService({ scope: db.forGym, clock, settings }) }),
    household: createPortalHouseholdService(shared),
    billing: createPortalBillingService({ ...shared, clock, checkout: unused, uploadsFor: unused }),
    waivers: createPortalWaiverService({ ...shared, clock, waivers: unused }),
    progress: createPortalProgressService({ ...shared, ranks: () => ranks, attendance: () => attendance }) };
}
const paged = <T>(rows: T[], query: { limit: number; offset: number }) => ({ rows: rows.slice(query.offset, query.offset + query.limit), total: rows.length });
const ids = (answer: { data: { id: string }[]; pagination: { total: number } }) => ({ rows: answer.data.map(row => row.id), total: answer.pagination.total });
const idsOf = (answer: { rows: { id: string }[]; total: number }) => ({ rows: answer.rows.map(row => row.id), total: answer.total });
const grant = (identity: PortalIdentity) => ({ kind: 'user' as const, ...identity });
type Fixture = typeof large;
type Oracle = { new: (s: ReturnType<typeof services>, f: Fixture) => Promise<unknown>; old: (f: Fixture) => Promise<unknown> };
/** Direct test queries in gym scope: every row of the fixture's household, before any filter. */
const members = (f: Fixture) => [f.payer.id, f.child.id, f.adult.id];
const all = {
  bookings: (f: Fixture) => db.forGym(gymId, tx => tx.select().from(classBookings).where(inArray(classBookings.memberId, members(f)))),
  invoices: (f: Fixture) => db.forGym(gymId, tx => tx.select().from(invoices).where(eq(invoices.householdId, f.identity.householdId))),
  attendance: (f: Fixture) => db.forGym(gymId, tx => tx.select().from(attendances).where(inArray(attendances.memberId, members(f)))),
  ranks: (f: Fixture) => db.forGym(gymId, tx => tx.select().from(memberRanks).where(inArray(memberRanks.memberId, members(f)))),
  memberships: (f: Fixture) => db.forGym(gymId, tx => tx.select().from(memberships).where(inArray(memberships.memberId, members(f)))),
  waivers: (f: Fixture) => db.forGym(gymId, tx => tx.select().from(waiverSignatures).where(inArray(waiverSignatures.memberId, members(f)))),
};

const bookingsOracle = (filter: { sessionId?: string; status?: string }, query: typeof page) => async (f: Fixture) =>
  idsOf(paged((await all.bookings(f)).filter(row => row.memberId === f.child.id
    && (!filter.sessionId || row.sessionId === filter.sessionId) && (!filter.status || row.status === filter.status))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)), query));
const invoicesOracle = (status: string | undefined, query: typeof page) => async (f: Fixture) =>
  idsOf(paged((await all.invoices(f)).filter(row => row.status !== 'draft' && (!status || row.status === status))
    .sort((a, b) => b.dueOn.localeCompare(a.dueOn) || (b.number ?? 0) - (a.number ?? 0) || b.id.localeCompare(a.id)), query));
/** The old household branch: every row of the household, then the session links, then the filters in memory. */
const attendanceRows = async (f: Fixture, filter: { programId?: string; tagId?: string; since?: string; classesOnly?: boolean }) => {
  const rows = await all.attendance(f);
  const links = await db.forGym(gymId, async tx => ({ programs: await tx.select().from(classSessionPrograms), tags: await tx.select().from(classSessionTags) }));
  return rows.filter(row => row.memberId === f.child.id
    && (!filter.since || row.occurredAt.getTime() >= Date.parse(filter.since)) && (!filter.classesOnly || row.kind === 'class')
    && (!filter.programId || row.programId === filter.programId || links.programs.some(link => link.sessionId === row.sessionId && link.programId === filter.programId))
    && (!filter.tagId || links.tags.some(link => link.sessionId === row.sessionId && link.tagId === filter.tagId)))
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.id.localeCompare(b.id));
};
const signedOracle = (memberIds: (f: Fixture) => string[]) => async (f: Fixture) => {
  const visible = memberIds(f);
  return idsOf(paged((await all.waivers(f)).filter(row => visible.includes(row.memberId))
    .sort((a, b) => b.signedAt.getTime() - a.signedAt.getTime() || b.id.localeCompare(a.id)), page));
};
const pendingOracle = async (f: Fixture) => {
  const current = await db.forHousehold(grant(f.identity), q => q.waiverTemplates()), signatures = await all.waivers(f);
  current.sort((a, b) => a.name.localeCompare(b.name));
  return [f.child.id].flatMap(memberId => current.filter(template => !signatures.some(row => row.memberId === memberId && row.templateId === template.id))
    .map(template => [memberId, template.id]));
};

/** One case per changed read. Each reads one page of the new path and the old whole collection, narrowed in memory. */
const reads: Record<string, Oracle> = {
  'bookings list': { new: async (s, f) => ids(await s.bookings.list(f.identity, page, f.child.id)), old: bookingsOracle({}, page) },
  'bookings list by status': { new: async (s, f) => ids(await s.bookings.list(f.identity, { ...page, status: 'waitlisted' }, f.child.id)), old: bookingsOracle({ status: 'waitlisted' }, page) },
  'bookings list past the end': { new: async (s, f) => ids(await s.bookings.list(f.identity, { limit: 20, offset: 5000 }, f.child.id)), old: bookingsOracle({}, { limit: 20, offset: 5000 }) },
  'schedule places': {
    new: async (s, f) => (await s.schedule.sessions(f.identity, { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z', limit: 100, offset: 0 }))
      .data.flatMap(session => session.bookings.map(row => row.id)).sort(),
    old: async f => {
      const sessions = await db.forGym(gymId, tx => tx.select({ id: classSessions.id, startsAt: classSessions.startsAt }).from(classSessions));
      const rows = await all.bookings(f);
      // The page of 100 sessions the schedule shows: the gym's earliest, in start order.
      const shown = new Set(sessions.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id)).slice(0, 100).map(row => row.id));
      return rows.filter(row => shown.has(row.sessionId) && row.status !== 'cancelled').map(row => row.id).sort();
    } },
  'memberships': {
    new: async (s, f) => ids(await s.household.memberships(f.identity, f.child.id, { limit: 3, offset: 2 })),
    old: async f => idsOf(paged((await all.memberships(f)).filter(row => row.memberId === f.child.id)
      .sort((a, b) => b.startsOn.localeCompare(a.startsOn) || b.id.localeCompare(a.id)), { limit: 3, offset: 2 })) },
  'invoices': { new: async (s, f) => ids(await s.billing.list(f.identity, page)), old: invoicesOracle(undefined, page) },
  'invoices by status': { new: async (s, f) => ids(await s.billing.list(f.identity, { ...page, status: 'paid' })), old: invoicesOracle('paid', page) },
  'signed waivers': { new: async (s, f) => ids(await s.waivers.signed(f.identity, 'household', page)), old: signedOracle(f => [f.payer.id, f.child.id, f.adult.id]) },
  'signed waivers of one member': { new: async (s, f) => ids(await s.waivers.signed(f.identity, 'household', { ...page, memberId: f.child.id })), old: signedOracle(f => [f.child.id]) },
  'pending waivers': {
    new: async (s, f) => (await s.waivers.pending(f.identity, 'household', { limit: 100, offset: 0, memberId: f.child.id })).data.map(row => [row.memberId, row.template.id]),
    old: pendingOracle },
  'rank history': {
    new: async (s, f) => (await s.progress.progress(f.identity, f.child.id)).history.map(row => row.id),
    old: async f => (await all.ranks(f)).filter(row => row.memberId === f.child.id)
      .sort((a, b) => b.promotedAt.getTime() - a.promotedAt.getTime() || b.subRank - a.subRank).map(row => row.id) },
  'attendance': {
    new: async (s, f) => ids(await s.progress.attendance(f.identity, f.child.id, page)),
    old: async f => idsOf(paged(await attendanceRows(f, {}), page)) },
  'attendance by program': {
    new: async (s, f) => ids(await s.progress.attendance(f.identity, f.child.id, { ...page, programId: program })),
    old: async f => idsOf(paged(await attendanceRows(f, { programId: program }), page)) },
  'attendance by class tag': {
    new: async (s, f) => ids(await s.progress.attendance(f.identity, f.child.id, { ...page, tagId: tag })),
    old: async f => idsOf(paged(await attendanceRows(f, { tagId: tag }), page)) },
  'attendance since': {
    new: async (s, f) => ids(await s.progress.attendance(f.identity, f.child.id, { ...page, since: '2026-01-01T02:00:00.000Z' })),
    old: async f => idsOf(paged(await attendanceRows(f, { since: '2026-01-01T02:00:00.000Z' }), page)) },
  'rank attendance count': {
    new: (s, f) => s.attendance.countSince({ kind: 'household', identity: f.identity },
      { memberId: f.child.id, programId: program, classesOnly: true, since: '2026-01-01T00:00:00.000Z' }),
    old: async f => (await attendanceRows(f, { programId: program, classesOnly: true, since: '2026-01-01T00:00:00.000Z' })).length },
};

describe('bounded portal reads', () => {
  it.each(Object.keys(reads))('%s returns the rows of the whole-collection read, in its order', async name => {
    const read = reads[name]!;
    for (const f of [large, small]) expect(await read.new(services(db.forHousehold), f)).toEqual(await read.old(f));
  });

  it('counts open mat as classes only when the gym does', async () => {
    const f = large, stored = createGymSettingsAccessor({ scope: db.forGym });
    const count = (openMatCountsAsClass: boolean) => createAttendanceQueries({ scope: db.forGym, householdScope: db.forHousehold, clock,
      settings: { ...stored, get: async id => ({ ...await stored.get(id), openMatCountsAsClass }) } })
      .countSince({ kind: 'household', identity: f.identity }, { memberId: f.child.id, classesOnly: true, since: '2026-01-01T00:00:00.000Z' });
    expect(await count(false)).toBe((await attendanceRows(f, { classesOnly: true })).length);
    expect(await count(true)).toBe((await attendanceRows(f, {})).length);
  });

  it('counts the same attendance in household and gym scope, filter by filter', async () => {
    const queries = services(db.forHousehold).attendance, since = '2026-01-01T00:00:00.000Z';
    const filters: { programId?: string; tagId?: string; classesOnly?: boolean; since?: string; until?: string }[] = [{}, { programId: program },
      { programId: ranked }, { tagId: tag }, { classesOnly: true }, { since: '2026-01-01T02:00:00.000Z' },
      { programId: program, tagId: tag, classesOnly: true, until: '2026-01-02T00:00:00.000Z' }];
    for (const f of [large, small]) for (const filter of filters) {
      const query = { memberId: f.child.id, since, ...filter };
      const household = await queries.countSince({ kind: 'household', identity: f.identity }, query);
      expect(household).toBe(await queries.countSince({ kind: 'gym', gymId }, query));
      expect(household).toBe((await attendanceRows(f, query)).filter(row => !query.until || row.occurredAt.getTime() < Date.parse(query.until)).length);
    }
  });

  it.each(Object.keys(reads))('%s keeps its query count and rows read as the history grows tenfold', async name => {
    const read = reads[name]!, sizes = [];
    for (const f of [small, large]) {
      const { seen, scope } = counting();
      await read.new(services(scope), f);
      sizes.push(seen);
    }
    expect(sizes[1]!.queries).toBe(sizes[0]!.queries);
    // A page is at most 100 rows, plus the grant's few member and template lookups.
    expect(sizes[1]!.rows).toBeLessThanOrEqual(120);
  });

  it('never reads another household through any bounded read', async () => {
    const s = services(db.forHousehold), f = large, outside = small, stranger = small.identity;
    const missing = expect.objectContaining({ code: 'not_found' });
    await expect(s.bookings.list(stranger, { limit: 20, offset: 0 }, f.child.id)).rejects.toEqual(missing);
    // A real booking of the other household, named with a member each login may act for.
    const { rows: [booking] } = await db.forHousehold(grant(f.identity), q => q.bookingPage({ memberId: f.child.id, status: 'booked' }, { limit: 1, offset: 0 }));
    await expect(s.bookings.cancel(stranger, booking!.id, outside.child.id)).rejects.toEqual(missing);
    await expect(s.bookings.cancel(f.identity, booking!.id, f.adult.id)).rejects.toEqual(missing);
    await expect(s.household.memberships(stranger, f.child.id, { limit: 20, offset: 0 })).rejects.toEqual(missing);
    await expect(s.progress.progress(stranger, f.child.id)).rejects.toEqual(missing);
    await expect(s.progress.attendance(stranger, f.child.id, { limit: 20, offset: 0 })).rejects.toEqual(missing);
    await expect(s.attendance.countSince({ kind: 'household', identity: stranger }, { memberId: f.child.id, since: '2026-01-01T00:00:00.000Z' })).rejects.toEqual(missing);
    await expect(s.waivers.pending(stranger, 'household', { limit: 20, offset: 0, memberId: f.child.id })).rejects.toEqual(missing);
    await expect(s.waivers.signed(stranger, 'household', { limit: 20, offset: 0, memberId: f.child.id })).rejects.toEqual(missing);
    const [foreign] = await all.waivers(f);
    await expect(s.waivers.pdf(stranger, 'household', foreign!.id)).rejects.toEqual(missing);
    const own = (await s.billing.list(f.identity, { limit: 100, offset: 0 })).data.map(row => row.id);
    expect((await s.billing.list(stranger, { limit: 100, offset: 0 })).data.map(row => row.id).filter(id => own.includes(id))).toEqual([]);
    const places = (await s.schedule.sessions(stranger, { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z', limit: 100, offset: 0 })).data;
    const members = new Set([outside.payer.id, outside.child.id, outside.adult.id]);
    expect(places.flatMap(session => session.bookings).every(row => members.has(row.memberId))).toBe(true);
  });

  it('keeps an adult non-payer to their own rows within the household', async () => {
    const s = services(db.forHousehold), f = large, missing = expect.objectContaining({ code: 'not_found' });
    await expect(s.bookings.list(f.adultIdentity, { limit: 20, offset: 0 }, f.child.id)).rejects.toEqual(missing);
    await expect(s.household.memberships(f.adultIdentity, f.child.id, { limit: 20, offset: 0 })).rejects.toEqual(missing);
    await expect(s.progress.attendance(f.adultIdentity, f.child.id, { limit: 20, offset: 0 })).rejects.toEqual(missing);
    await expect(s.billing.list(f.adultIdentity, { limit: 20, offset: 0 })).rejects.toBeInstanceOf(AppError);
    const own = await s.waivers.signed(f.adultIdentity, 'self', { limit: 100, offset: 0 });
    expect(own.data.length).toBeGreaterThan(0);
    expect(own.data.every(row => row.memberId === f.adult.id)).toBe(true);
    const places = (await s.schedule.sessions(f.adultIdentity, { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z', limit: 100, offset: 0 })).data;
    expect(places.flatMap(session => session.bookings).every(row => row.memberId === f.adult.id)).toBe(true);
  });
});
