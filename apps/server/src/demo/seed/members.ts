// SPDX-License-Identifier: AGPL-3.0-only
import { forGym } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { MemberStatus } from '@plaingym/shared/contracts';
import { addDays, localDate } from '@plaingym/shared/time';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { createMembersService, type MembersService } from '../../areas/members/members.js';
import type { HouseholdPinSecret } from '../../areas/members/pin.js';
import { createGymKeyResolver } from '../../areas/settings/gym-keys.js';
import { createStaffProfileService } from '../../areas/staff/profiles.js';
import type { SeedStep } from './index.js';

export const day = 86_400_000;
/** Every seeded household shares this kiosk PIN, so visitors can try name and PIN check-in. */
export const demoPin = '2468';
export interface DemoMember {
  readonly firstName: string; readonly lastName: string; readonly age: number; readonly status: MemberStatus;
  readonly joinedDaysAgo: number; readonly tags?: readonly string[]; readonly medicalNotes?: string;
}
export interface DemoHousehold { readonly name: string; readonly slug: string; readonly phone: string; readonly members: readonly DemoMember[] }
const adult = (firstName: string, lastName: string, age: number, joinedDaysAgo: number, extra: Partial<DemoMember> = {}): DemoMember =>
  ({ firstName, lastName, age, status: 'active', joinedDaysAgo, ...extra });
/** Fictional people; every address uses the reserved `.invalid` domain and 555-01xx numbers. */
export const demoHouseholds: readonly DemoHousehold[] = [
  { name: 'Rivera family', slug: 'rivera', phone: '555-0101', members: [
    adult('Marcus', 'Rivera', 38, 900, { tags: ['Competition team'] }), adult('Sofia', 'Rivera', 36, 300),
    adult('Mateo', 'Rivera', 9, 400), adult('Lucia', 'Rivera', 7, 150, { medicalNotes: 'Mild asthma; her inhaler is in her bag.' })] },
  { name: 'Chen family', slug: 'chen', phone: '555-0102', members: [adult('Daniel', 'Chen', 41, 60), adult('Ava', 'Chen', 10, 500)] },
  { name: 'Khan family', slug: 'khan', phone: '555-0103', members: [
    adult('Aisha', 'Khan', 33, 1100, { tags: ['Competition team'] }), adult('Zoe', 'Khan', 6, 10, { status: 'trial' })] },
  { name: 'Becker family', slug: 'becker', phone: '555-0104', members: [adult('Tom', 'Becker', 45, 200), adult('Leo', 'Becker', 8, 250)] },
  { name: 'Adeyemi family', slug: 'adeyemi', phone: '555-0105', members: [
    adult('Tobi', 'Adeyemi', 30, 500, { tags: ['Competition team'] }), adult('Kemi', 'Adeyemi', 12, 300)] },
  { name: 'Elena Petrova', slug: 'petrova', phone: '555-0106', members: [adult('Elena', 'Petrova', 52, 1500, { tags: ['Founding member'] })] },
  { name: 'Kenji Watanabe', slug: 'watanabe', phone: '555-0107', members: [adult('Kenji', 'Watanabe', 27, 400)] },
  { name: "Grace O'Neill", slug: 'oneill', phone: '555-0108', members: [adult('Grace', "O'Neill", 31, 180, { tags: ['Needs follow-up'] })] },
  { name: 'Owen Murphy', slug: 'murphy', phone: '555-0109', members: [adult('Owen', 'Murphy', 26, 220)] },
  { name: 'Bruno Silva', slug: 'silva', phone: '555-0110', members: [adult('Bruno', 'Silva', 22, 30)] },
  { name: 'Luis Ortega', slug: 'ortega', phone: '555-0111', members: [adult('Luis', 'Ortega', 40, 700, { status: 'frozen' })] },
  { name: 'Hannah Schmidt', slug: 'schmidt', phone: '555-0112', members: [adult('Hannah', 'Schmidt', 24, 5, { status: 'trial' })] },
  { name: 'Noah Williams', slug: 'williams', phone: '555-0113', members: [adult('Noah', 'Williams', 35, 2, { status: 'prospect' })] },
  { name: 'Marta Novak', slug: 'novak', phone: '555-0114', members: [adult('Marta', 'Novak', 34, 800, { status: 'cancelled' })] },
];
const memberTags: Readonly<Record<string, string>> = { 'Competition team': '#dc2626', 'Founding member': '#ca8a04', 'Needs follow-up': '#2563eb' };
/** The owner and coach profiles link to the gym's first owner (or admin) and coach accounts when they have none yet. */
export const demoStaff = [
  { displayName: 'Ana Ribeiro', account: 'manager', rank: 'Black belt', bio: 'Head instructor. Teaches the evening gi classes and runs the competition team.' },
  { displayName: 'Jordan Lee', account: 'coach', rank: 'Brown belt', bio: 'Teaches the early fundamentals classes; patient with beginners.' },
  { displayName: 'Priya Nair', account: null, rank: 'Purple belt', bio: 'Runs the kids program: games, movement, and good habits on and off the mat.' },
  { displayName: 'Sam Okafor', account: null, rank: 'Black belt', bio: 'No-gi and competition coach.' },
] as const;
export const householdEmail = (home: DemoHousehold) => `${home.slug}@example.invalid`;
export const memberKey = (member: { firstName: string; lastName: string }) => `${member.firstName} ${member.lastName}`;
/** A seed-local clock lets the real services backdate join dates without bypassing them. */
export function settableClock(initial: Date | number) {
  let current = new Date(initial);
  return { now: () => new Date(current), set(time: Date | number) { current = new Date(time); } };
}
const page = { limit: 100, offset: 0 } as const;
/** A few members at a time keeps seeding quick without taking over the connection pool.
 * After a failure no new item starts, and the error surfaces only once in-flight work settles. */
export async function inBatches<T>(items: readonly T[], work: (item: T) => Promise<void>, concurrency = 4) {
  let next = 0, failed = false, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      try { await work(items[next++]!); } catch (error) { if (!failed) failure = error; failed = true; }
    }
  }));
  if (failed) throw failure;
}

/** Seeded members by name, found through their seeded households so a gym's own members are never matched. */
export async function findDemoMembers(service: Pick<MembersService, 'listHouseholds' | 'listMembers'>, gymId: string) {
  const found = new Map<string, Awaited<ReturnType<MembersService['listMembers']>>['data'][number]>();
  for (const home of demoHouseholds) {
    const household = await findHousehold(service, gymId, home);
    if (household) for (const row of (await service.listMembers(gymId, { ...page, householdId: household.id })).data) found.set(memberKey(row), row);
  }
  return found;
}
async function findHousehold(service: Pick<MembersService, 'listHouseholds'>, gymId: string, home: DemoHousehold) {
  return (await service.listHouseholds(gymId, { ...page, search: home.name })).data.find((row) => row.name === home.name && row.email === householdEmail(home));
}
/** PINs need the gym key; without `APP_ENCRYPTION_KEY` (a bare development shell) households get no PIN. */
function environmentPinSecret(scope: typeof forGym): HouseholdPinSecret | null {
  const key = process.env.APP_ENCRYPTION_KEY;
  return key ? createGymKeyResolver({ key: parseEncryptionKey(key), scope }) : null;
}

export function membersSeed(options: { scope?: typeof forGym; clock?: Clock; pinSecret?: HouseholdPinSecret | null } = {}): SeedStep {
  const scope = options.scope ?? forGym;
  return { id: 'members', async run(context) {
    const now = (options.clock ?? defaultClock).now(), at = settableClock(now), today = localDate(now, context.timezone);
    const pinSecret = options.pinSecret === undefined ? environmentPinSecret(scope) : options.pinSecret;
    const service = (clock: Clock) => createMembersService({ scope, clock, ...(pinSecret ? { pinSecret } : {}) });
    const actor: MutationContext = { gymId: context.gymId, actor: { kind: 'system' } };
    const tags = new Map((await service(at).listTags(context.gymId, page)).data.map((row) => [row.name, row.id]));
    for (const [name, color] of Object.entries(memberTags)) if (!tags.has(name)) tags.set(name, (await service(at).createTag(actor, { name, color })).id);
    await inBatches(demoHouseholds, async (home) => {
      const joined = settableClock(now.getTime() - Math.max(...home.members.map((member) => member.joinedDaysAgo)) * day), members = service(joined);
      let household = await findHousehold(members, context.gymId, home);
      if (!household) {
        household = await members.createHousehold(actor, { name: home.name, email: householdEmail(home), phone: home.phone,
          address: { city: 'Riverside', countryCode: 'US' } });
        if (pinSecret) household = await members.setHouseholdPin(actor, household.id, { pin: demoPin, revision: household.revision });
      }
      const existing = new Map((await members.listMembers(context.gymId, { ...page, householdId: household.id })).data.map((row) => [memberKey(row), row]));
      const guardian = home.members.find((member) => member.age >= 18);
      for (const person of home.members) {
        let row = existing.get(memberKey(person));
        if (!row) {
          joined.set(now.getTime() - person.joinedDaysAgo * day);
          const minor = person.age < 18;
          row = await members.createMember(actor, { householdId: household.id, firstName: person.firstName, lastName: person.lastName,
            status: person.status, dateOfBirth: addDays(today, -(person.age * 365 + person.joinedDaysAgo % 200)),
            email: minor ? null : `${person.firstName.toLowerCase()}.${home.slug}@example.invalid`, phone: minor ? null : home.phone,
            emergencyContacts: [minor && guardian
              ? { name: memberKey(guardian), relationship: 'Parent', phone: home.phone, email: null }
              : { name: 'Sam Doe', relationship: 'Partner', phone: '555-0199', email: null }] });
          if (person.medicalNotes) await members.updateMedicalNotes(actor, row.id, { medicalNotes: person.medicalNotes, revision: row.revision });
        }
        for (const tag of person.tags ?? []) await members.addTag(actor, row.id, { tagId: tags.get(tag)! });
      }
    });
    await seedStaffProfiles(scope, { now: () => now }, context.gymId);
  } };
}

/** Profiles are created as the gym's owner (or admin), as staff management requires; a gym without one gets none. */
async function seedStaffProfiles(scope: typeof forGym, clock: Clock, gymId: string) {
  const staff = createStaffProfileService(scope);
  const roles = (await staff.listRoles(gymId, page)).data;
  const manager = roles.find((row) => row.role === 'owner') ?? roles.find((row) => row.role === 'admin');
  if (!manager) return;
  const accounts = { manager: manager.userId, coach: roles.find((row) => row.role === 'coach')?.userId };
  for (const profile of demoStaff) {
    if ((await staff.listProfiles(gymId, { ...page, search: profile.displayName })).data.some((row) => row.displayName === profile.displayName)) continue;
    const account = profile.account ? accounts[profile.account] : undefined;
    const unlinked = account && (await staff.listProfiles(gymId, { ...page, userId: account })).pagination.total === 0;
    await staff.createProfile({ gymId, actorUserId: manager.userId, clock }, { displayName: profile.displayName, bio: profile.bio,
      rank: profile.rank, isPublic: true, ...(unlinked ? { userId: account } : {}) });
  }
}
export const seeds: readonly SeedStep[] = [membersSeed()];
