// SPDX-License-Identifier: AGPL-3.0-only
// Test-only composition shared by the portal schedule, check-in and progress tests.
import { uuidv7 } from '@plaingym/db';
import type { useTestDatabase } from '@plaingym/db/testing/database';
import type { createFactories } from '@plaingym/db/testing/factories';
import { createApp } from '../../core/app.js';
import type { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { createCheckinCodeService } from '../members/checkin-code.js';
import { createBookingService } from '../bookings/bookings.js';
import { createScheduleService } from '../schedule/schedule.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createAttendanceQueries } from '../attendance/attendance.js';
import { createPromotionCriteria } from '../ranks/criteria.js';
import { createRanksService } from '../ranks/ranks.service.js';
import { createPortalAuthorization } from './auth.permissions.js';
import { createPortalBookingService } from './bookings.js';
import { createPortalBookingRoutes } from './bookings.routes.js';
import { createPortalScheduleService } from './schedule.js';
import { createPortalScheduleRoutes } from './schedule.routes.js';
import { createPortalCheckinService } from './checkin.js';
import { createPortalCheckinRoutes } from './checkin.routes.js';
import { createPortalProgressService } from './progress.js';
import { createPortalProgressRoutes } from './progress.routes.js';

type Database = ReturnType<typeof useTestDatabase>;
type Factory = ReturnType<typeof createFactories>;
export const gymKey = new Uint8Array(32).fill(9);

/** One household with a payer parent, a child, an adult non-payer, a cancelled and an erased member; a second household in the same gym. */
export async function portalFixture(factory: Factory) {
  const gymId = uuidv7(); await factory('gyms', gymId, { bookingWindowDays: 7, cancellationCutoffMinutes: 60 });
  const [payer, adult, neighbour, staff] = await Promise.all([1, 2, 3, 4].map(() => factory('authUser', gymId)));
  const joined = new Date('2026-01-01T00:00:00Z');
  const parent = await factory('members', gymId, { createdAt: joined, firstName: 'Pat', lastName: 'Parent', status: 'active', dateOfBirth: '1985-03-01' });
  const householdId = parent.householdId;
  const child = await factory('members', gymId, { createdAt: joined, householdId, firstName: 'Casey', lastName: 'Parent', status: 'active', dateOfBirth: '2016-05-01' });
  const grown = await factory('members', gymId, { createdAt: joined, householdId, firstName: 'Alex', lastName: 'Parent', status: 'active' });
  const cancelled = await factory('members', gymId, { createdAt: joined, householdId, firstName: 'Former', lastName: 'Member', status: 'cancelled' });
  const erased = await factory('members', gymId, { createdAt: joined, householdId, firstName: 'Erased', lastName: 'Member', anonymizedAt: new Date('2026-10-01Z') });
  const other = await factory('members', gymId, { createdAt: joined, firstName: 'Olive', lastName: 'Other', status: 'active' });
  await factory('householdUsers', gymId, { householdId, userId: payer!.id, memberId: parent.id, scope: 'payer' });
  await factory('householdUsers', gymId, { householdId, userId: adult!.id, memberId: grown.id, scope: 'member' });
  await factory('householdUsers', gymId, { householdId: other.householdId, userId: neighbour!.id, memberId: other.id, scope: 'payer' });
  const session = await factory('classSessions', gymId, { name: 'Fundamentals', capacity: 2, notes: 'Coach-only note',
    startsAt: new Date('2026-10-30T18:00:00Z'), endsAt: new Date('2026-10-30T19:00:00Z') });
  const open = await factory('classSessions', gymId, { name: 'Open training', capacity: null,
    startsAt: new Date('2026-10-30T20:00:00Z'), endsAt: new Date('2026-10-30T21:00:00Z') });
  const program = await factory('programs', gymId, { name: 'Core' });
  for (const sessionId of [session.id, open.id]) await factory('classSessionPrograms', gymId, { sessionId, programId: program.id });
  const ids = { gymId, householdId, program, payer: payer!, adult: adult!, neighbour: neighbour!, staff: staff! };
  const principal = (user: 'payer' | 'adult' | 'neighbour'): Principal => user === 'payer'
    ? { kind: 'member', userId: payer!.id, scope: { gymId, householdId, memberId: parent.id, role: 'payer' } }
    : user === 'adult' ? { kind: 'member', userId: adult!.id, scope: { gymId, householdId, memberId: grown.id, role: 'member' } }
      : { kind: 'member', userId: neighbour!.id, scope: { gymId, householdId: other.householdId, memberId: other.id, role: 'payer' } };
  return { ...ids, parent, child, grown, cancelled, erased, other, session, open, principal,
    identity: (user: 'payer' | 'adult' | 'neighbour' = 'payer') => {
      const scope = principal(user) as Extract<Principal, { kind: 'member' }>;
      return { gymId, householdId: scope.scope.householdId, userId: scope.userId };
    } };
}
export type PortalFixture = Awaited<ReturnType<typeof portalFixture>>;

/** Real services over the test database, mounted behind the production portal authorization. */
export function portalServices(db: Database, clock: TestClock, options: { configured?: boolean } = {}) {
  const households = createMemberHouseholdContext(db.forGym), configured = options.configured ?? true;
  const settings = createGymSettingsAccessor({ scope: db.forGym });
  const bookings = createBookingService({ scope: db.forGym, clock, settings });
  const codes = createCheckinCodeService({ scope: db.forGym, clock, gymKey: async () => gymKey });
  const attendance = createAttendanceQueries({ scope: db.forGym, householdScope: db.forHousehold, clock, settings });
  const ranks = createRanksService({ scope: db.forGym, clock, criteria: createPromotionCriteria(attendance), settings });
  const shared = { households, householdScope: db.forHousehold };
  const routes = [
    ...createPortalScheduleRoutes(createPortalScheduleService({ ...shared, bookings, settings, schedule: createScheduleService({ scope: db.forGym, clock, settings }) })),
    ...createPortalBookingRoutes(createPortalBookingService({ ...shared, bookings })),
    ...createPortalCheckinRoutes(createPortalCheckinService({ ...shared, codes: () => configured ? codes : undefined })),
    ...createPortalProgressRoutes(createPortalProgressService({ ...shared, ranks: () => configured ? ranks : undefined, attendance: () => attendance })),
  ];
  function app(gymId: string, principal: Principal) {
    return createApp({ clock, skipSetup: true, origin: 'http://localhost', contributions: { routes },
      resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
      session: async (c, next) => { c.set('context', { ...c.get('context'), principal }); await next(); },
      authorize: createPortalAuthorization(households) });
  }
  return { app, bookings, codes, ranks, attendance, settings };
}
export const post = (server: ReturnType<ReturnType<typeof portalServices>['app']>, path: string, body: unknown = {}) => server.request(path, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(body) });
