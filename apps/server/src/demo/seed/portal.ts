// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { auditEvents, forGym, householdUsers, households, invoices, uuidv7, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { ClassSession } from '@plaingym/shared/contracts';
import { addDays, localDate, zonedInstant } from '@plaingym/shared/time';
import { clock as defaultClock } from '../../core/clock.js';
import { logError } from '../../core/log.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { createAttendanceQueries, createAttendanceService } from '../../areas/attendance/attendance.js';
import { createCatalogService } from '../../areas/billing/catalog.js';
import { createCustomersService } from '../../areas/billing/customers.js';
import { createMembershipService } from '../../areas/billing/memberships.js';
import { createChargeRunner } from '../../areas/billing/runner/index.js';
import { audit, system } from '../../areas/billing/runner/store.js';
import { createInvoiceTransitions } from '../../areas/billing/transitions/index.js';
import { createCardHandlers } from '../../areas/billing/webhooks/handlers/methods.js';
import { createBookingService } from '../../areas/bookings/bookings.js';
import { createCheckinCodeService } from '../../areas/members/checkin-code.js';
import { createMembersService } from '../../areas/members/members.js';
import type { HouseholdPinSecret } from '../../areas/members/pin.js';
import { createPromotionCriteria } from '../../areas/ranks/criteria.js';
import { createRanksService } from '../../areas/ranks/ranks.service.js';
import { createScheduleService } from '../../areas/schedule/schedule.js';
import { createGoLiveService } from '../../areas/settings/go-live.js';
import { createGymSettingsAccessor } from '../../areas/settings/settings.js';
import { createStaffProfileService } from '../../areas/staff/profiles.js';
import { createWaiversService, type WaiverOptions } from '../../areas/waivers/waivers.js';
import { demoEmail, demoStudent } from '../identities.js';
import { demoPlans, seedCalendar, seedTestCard, settleSeedPeriods } from './billing.js';
import type { BillingSeedProvider } from './billing-payments.js';
import { sessionsBetween } from './mat.js';
import { day, demoPin, environmentPinSecret, findDemoMembers, settableClock } from './members.js';
import { demoSignaturePng } from './waivers-image.js';
import type { SeedStep } from './index.js';

const page = { limit: 100, offset: 0 } as const, hour = 3_600_000;
export { demoStudent };
/** Rank name, sub-rank and days ago, oldest first. Two classes a week since the last stripe leave the next one partly earned. */
export const studentPromotions = [['White belt', 0, 240], ['White belt', 1, 160], ['White belt', 2, 80]] as const;
export const studentClassesPerWeek = 2;
/** The competition team fills a small group class, so the student holds the first waitlist place. */
export const waitlistClass = 'Competition Training';
export const waitlistFillers = ['Marcus Rivera', 'Aisha Khan', 'Tobi Adeyemi'] as const;
/** Upcoming bookings start after this margin, so the cancellation cutoff is still ahead when the sandbox opens. */
const bookingMargin = 3 * hour, bookingHorizon = 7 * day;
const started = 'demo.portal.billing_started', completed = 'demo.portal.billing_completed';
const recorded = (tx: Transaction, action: string, targetId: string) => tx.select().from(auditEvents)
  .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId))).limit(1);

export interface PortalSeedOptions extends WaiverOptions {
  /** The gym's random key for PINs and QR check-in codes; omitted, it comes from `APP_ENCRYPTION_KEY`, null skips both. */
  pinSecret?: HouseholdPinSecret | null;
  /** The shared test account; without it the student gets no invoices and billing stays as it is. */
  billingPaymentsFor?: (gymId: string) => Promise<BillingSeedProvider>;
}

/** Gives the sandbox's one-click student a portal worth exploring, through the same services staff and members use. */
export function portalSeed(options: PortalSeedOptions): SeedStep {
  const scope = options.scope ?? forGym;
  return { id: 'portal', async run(context) {
    const gymId = context.gymId, now = (options.clock ?? defaultClock).now(), fixed = { now: () => new Date(now) };
    const actor: MutationContext = { gymId, actor: { kind: 'system' } };
    const key = options.pinSecret === undefined ? environmentPinSecret(scope) : options.pinSecret;
    const people = createMembersService({ scope, clock: fixed, ...(key ? { pinSecret: key } : {}) });
    const student = await findStudent(scope, people, gymId);
    // Only demo sandboxes have the student login; the seed command leaves other gyms alone.
    if (!student) return;
    const { household, member } = student;
    if (key && !await scope(gymId, async tx => (await tx.select({ pin: households.pinHash }).from(households).where(eq(households.id, household.id)))[0]?.pin))
      await people.setHouseholdPin(actor, household.id, { pin: demoPin, revision: household.revision });

    // An adult birth date lets the student sign their own waiver; a signed current waiver keeps the kiosk's standing checks green.
    if (!member.dateOfBirth) await people.updateMember(actor, member.id,
      { dateOfBirth: addDays(localDate(now, context.timezone), -(29 * 365 + 40)), revision: member.revision });
    const waivers = createWaiversService(options);
    const template = (await waivers.listTemplates(gymId, { limit: 100 })).data.find(row => row.name === 'Demo participation waiver');
    if (template && !(await waivers.listSignatures(gymId, { memberId: member.id, templateId: template.id })).pagination.total) {
      const uploaded = await waivers.uploadSignature(actor, member.id, demoSignaturePng());
      await waivers.sign(actor, { memberId: member.id, templateId: template.id, templateVersion: template.version,
        signer: { kind: 'self', name: `${member.firstName} ${member.lastName}` }, ...uploaded, consent: true },
      { timezone: context.timezone, ipAddress: 'demo-seed' });
    }

    if (key) {
      const codes = createCheckinCodeService({ scope, clock: fixed, gymKey: key });
      const current = await codes.read(gymId, member.id);
      if (!current.code) await codes.regenerate(actor, member.id, { revision: current.revision });
    }

    const schedule = createScheduleService({ scope, clock: fixed });
    const ranks = createRanksService({ scope, clock: fixed, criteria: createPromotionCriteria(createAttendanceQueries({ scope })) });
    const program = (await ranks.listPrograms(gymId, page)).data.find(row => row.name === 'BJJ All Levels');
    const sessions = program?.rankSystemId ? await sessionsBetween(schedule, gymId, new Date(now.getTime() - 5 * 7 * day), new Date(now.getTime() + bookingHorizon)) : [];
    if (program?.rankSystemId) {
      await progress(scope, ranks, now, gymId, member.id, { id: program.id, rankSystemId: program.rankSystemId },
        sessions.filter(row => row.status === 'scheduled' && row.kind === 'class' && row.programIds.includes(program.id) && Date.parse(row.startsAt) < now.getTime()));
      await bookings(scope, fixed, gymId, student, sessions.filter(row => row.status === 'scheduled' && row.kind === 'class'
        && row.programIds.includes(program.id) && Date.parse(row.startsAt) > now.getTime() + bookingMargin));
    }
    if (options.billingPaymentsFor) await billing(scope, options.clock ?? defaultClock, gymId, household.id, member.id, await options.billingPaymentsFor(gymId));
  } };
}

interface Student {
  household: { id: string; revision: number }; member: { id: string; firstName: string; lastName: string; dateOfBirth: string | null; revision: number };
  login: { gymId: string; householdId: string; userId: string };
}
async function findStudent(scope: typeof forGym, people: ReturnType<typeof createMembersService>, gymId: string): Promise<Student | null> {
  const household = (await people.listHouseholds(gymId, { ...page, search: demoStudent.household }))
    .data.find(row => row.name === demoStudent.household && row.email === demoEmail(gymId, 'student'));
  if (!household) return null;
  const member = (await people.listMembers(gymId, { ...page, householdId: household.id }))
    .data.find(row => row.firstName === demoStudent.firstName && row.lastName === demoStudent.lastName);
  const [login] = await scope(gymId, tx => tx.select({ userId: householdUsers.userId }).from(householdUsers)
    .where(and(eq(householdUsers.householdId, household.id), eq(householdUsers.scope, 'payer'))));
  return member && login ? { household, member, login: { gymId, householdId: household.id, userId: login.userId } } : null;
}

/** Promotions through the ranks service, then visits since the last one through the attendance service. */
async function progress(scope: typeof forGym, ranks: ReturnType<typeof createRanksService>, now: Date, gymId: string, memberId: string,
  program: { id: string; rankSystemId: string }, past: ClassSession[]) {
  const actor: MutationContext = { gymId, actor: { kind: 'system' } };
  const list = (await ranks.listRanks(gymId, { ...page, rankSystemId: program.rankSystemId })).data;
  const done = new Set((await ranks.listPromotions(gymId, { ...page, memberId, programId: program.id })).data.map(row => `${row.rankId}:${row.subRank}`));
  for (const [rankName, subRank, daysAgo] of studentPromotions) {
    const rank = list.find(row => row.name === rankName);
    if (!rank) throw new Error(`Demo seed requires the "${rankName}" rank`);
    if (done.has(`${rank.id}:${subRank}`)) continue;
    await ranks.promote(actor, { memberId, programId: program.id, rankId: rank.id, rankSystemId: program.rankSystemId,
      subRank, promotedAt: new Date(now.getTime() - daysAgo * day).toISOString() });
  }
  const at = settableClock(now), attendance = createAttendanceService({ scope, clock: at }), target = 4 * studentClassesPerWeek;
  // A retry finishes a partial run; a later rerun, whose weeks have shifted, adds nothing once the target is reached.
  const visited = new Set((await attendance.list(gymId, { memberId, limit: 100, offset: 0 })).data.map(row => row.sessionId));
  const weeks = new Map<number, ClassSession[]>();
  for (const row of past) {
    const index = Math.floor((now.getTime() - Date.parse(row.startsAt)) / (7 * day));
    if (index < 4) weeks.set(index, [...weeks.get(index) ?? [], row]);
  }
  // The earliest classes of each week, each recorded at its own check-in time, as the kiosk would.
  for (const session of [...weeks.values()].flatMap(rows => rows.sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, studentClassesPerWeek))) {
    if (visited.size >= target) return;
    if (visited.has(session.id)) continue;
    visited.add(session.id);
    at.set(Date.parse(session.startsAt) - 5 * 60_000);
    await attendance.record(actor, { memberId, sessionId: session.id, programId: null, occurredAt: at.now().toISOString() }, { source: 'kiosk' });
  }
}

/** The student books two classes in the portal; the competition team fills a small class whose waitlist the student joins. */
async function bookings(scope: typeof forGym, clock: Clock, gymId: string, student: Student, upcoming: ClassSession[]) {
  const service = createBookingService({ scope, clock }), schedule = createScheduleService({ scope, clock });
  const self = { gymId, actor: { kind: 'user' as const, userId: student.login.userId }, portal: student.login };
  // Each part tops up what a failed or earlier run left, and a later rerun adds nothing once both are in place.
  const held = (await service.list(gymId, { ...page, memberId: student.member.id })).data.filter(row => row.status !== 'cancelled');
  const sorted = [...upcoming].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const reservable = sorted.filter(row => row.capacity !== null && row.name !== waitlistClass);
  // Reservations need a capacity; the small class gets one below.
  const small = sorted.find(row => row.name === waitlistClass);
  const missing = Math.max(0, 2 - held.filter(row => row.status === 'booked').length);
  for (const session of reservable.filter(row => !held.some(item => item.sessionId === row.id)).slice(0, missing))
    await service.book(self, { memberId: student.member.id, sessionId: session.id, allowWaitlist: false });
  if (held.some(row => row.status === 'waitlisted')) return;
  // Without the class the step fails rather than shrinking another public class (portal.md).
  if (!small) throw new Error(`Demo seed requires an upcoming ${waitlistClass} class`);
  const roles = (await createStaffProfileService(scope).listRoles(gymId, page)).data;
  const coach = roles.find(row => row.role === 'coach') ?? roles.find(row => row.role === 'owner');
  const team = await findDemoMembers(createMembersService({ scope, clock }), gymId);
  const fillers = waitlistFillers.flatMap(name => team.get(name) ?? []);
  if (!coach) throw new Error('Demo seed requires a coach or owner to book the waitlist class');
  if (fillers.length !== waitlistFillers.length) throw new Error('Demo seed requires the competition team members');
  if (small.capacity !== fillers.length) await schedule.changeSession({ gymId, actor: { kind: 'system' } }, small.id, 'capacity',
    { capacity: fillers.length, revision: small.revision });
  for (const member of fillers)
    await service.book({ gymId, actor: { kind: 'user', userId: coach.userId } }, { memberId: member.id, sessionId: small.id, allowWaitlist: false });
  await service.book(self, { memberId: student.member.id, sessionId: small.id, allowWaitlist: true });
}

/**
 * Three monthly periods like the other seeded households: older ones paid in cash, the current one charged to a test card.
 * Billing stays on after a completed run, so the sandbox's public join page takes payment through the shared test account.
 */
async function billing(scope: typeof forGym, clock: Clock, gymId: string, householdId: string, memberId: string, provider: BillingSeedProvider) {
  if (provider.mode !== 'test' || provider.gymId !== gymId) throw new Error('Portal seed requires this gym and test mode');
  const actor = system(gymId), settings = createGymSettingsAccessor({ scope, clock });
  // A completed run leaves the switch to the gym: the owner may have turned billing off since.
  if ((await scope(gymId, tx => recorded(tx, completed, householdId))).length) return;
  const switches = createGoLiveService({ scope, clock, smtpConfigured: async () => false });
  const initial = await switches.checklist(gymId);
  if (!initial.billingEnabled) await switches.update(actor, { revision: initial.revision, billingEnabled: true,
    confirmedPastDueDates: initial.pastDueMemberships.map(({ id, revision, nextDueOn }) => ({ id, revision, nextDueOn })) });
  try {
    const gym = await settings.get(gymId);
    // The first run anchors the calendar, so a retry on a later day repeats the same periods.
    const anchor = await scope(gymId, async tx => {
      const [existing] = await recorded(tx, started, householdId);
      if (existing) return existing.occurredAt;
      await audit(tx, actor, clock, started, 'household', householdId, {});
      return clock.now();
    });
    const calendar = seedCalendar(anchor, gym.timezone), at = settableClock(anchor);
    const plan = (await createCatalogService({ scope, clock: at, settings }).listPlans(gymId, page)).data.find(row => row.name === demoPlans[0].name);
    if (!plan) throw new Error('Run the billing seed before the portal seed');
    const customerId = await createCustomersService({ scope, clock, paymentsFor: async () => provider.payments }).ensureCustomer(gymId, householdId);
    await seedTestCard({ scope, clock, cards: createCardHandlers({ scope, clock: at }), provider }, gymId, householdId, customerId, false);
    const people = createMembersService({ scope, clock: at }), lifecycle = createMembershipService({ scope, clock: at, settings });
    const current = await people.getHouseholdBilling(gymId, householdId);
    if (current.billingDay !== calendar.billingDay) await people.updateHouseholdBilling(actor, householdId,
      { familyDiscountBasisPoints: current.familyDiscountBasisPoints, billingDay: calendar.billingDay, revision: current.revision });
    if (!(await lifecycle.list(gymId, { ...page, householdId })).data.some(row => row.memberId === memberId)) {
      at.set(zonedInstant(calendar.startsOn, '12:00', gym.timezone, { gap: 'shift' })!);
      await lifecycle.assign(actor, { id: uuidv7(), householdId, memberId, planId: plan.id, startsOn: calendar.startsOn,
        nextDueOn: calendar.startsOn, initialStatus: 'active', firstPeriod: 'next_billing_date' });
    }
    const transitions = createInvoiceTransitions({ scope, clock: at });
    const runner = createChargeRunner({ scope, clock: at, settings, transitions, payments: async () => provider.payments,
      // Transitions persist their normal effects for the runtime publisher; the seed enqueues nothing itself.
      jobs: { async enqueue() { throw new Error('Portal seed must not enqueue jobs directly'); } } });
    await settleSeedPeriods({ scope, at, transitions, runner }, gym, householdId, calendar);
    // The kiosk refuses a household with an overdue invoice, so the student's history must end paid.
    const cycles = await scope(gymId, tx => tx.select({ id: invoices.id }).from(invoices)
      .where(and(eq(invoices.householdId, householdId), eq(invoices.kind, 'cycle'))));
    const paid = await scope(gymId, tx => tx.select({ id: invoices.id }).from(invoices)
      .where(and(eq(invoices.householdId, householdId), eq(invoices.kind, 'cycle'), eq(invoices.status, 'paid'))));
    if (paid.length !== cycles.length) throw new Error('Demo student charge needs reconciliation before the seed can finish');
    await scope(gymId, tx => audit(tx, actor, clock, completed, 'household', householdId, {}));
  } catch (error) {
    // A failed run restores the gym's original switch, as the billing seed does. The seed's own failure is the one
    // reported: a restore that fails too is logged on its own and never replaces it.
    if (!initial.billingEnabled) {
      try {
        const current = await switches.checklist(gymId);
        await switches.update(actor, { revision: current.revision, billingEnabled: false });
      } catch (restoreError) { logError('demo.portal.billing_restore_failed', { gymId }, restoreError); }
    }
    throw error;
  }
}
