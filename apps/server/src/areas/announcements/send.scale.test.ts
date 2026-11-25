// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { auditEvents, classBookings, emailDeliveries, households, memberRanks, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { announcementDraftSchema } from '@plaingym/shared/contracts';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { FakeEmail } from '../../infra/email/index.js';
import { commandDigest } from '../../infra/email/deliveries.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createSmsPhoneDigest, FakeSms } from '../../infra/sms/index.js';
import { createAnnouncementsService } from './send.js';
import { createCancellationNotice } from './cancellation.js';
import { createRestoreNotice } from './restored.js';

const db = useTestDatabase(), factory = createFactories(db);
interface Read { sql: string; rows: number }
// Count actual executed SELECTs and returned rows, including the final transport guard.
function recording(reads: Read[]): typeof db.forGym {
  const watch = <T extends object>(builder: T): T => new Proxy(builder, { get(target, key, receiver) {
    const value = Reflect.get(target, key) as unknown;
    if (typeof value !== 'function' || key === 'constructor') return value;
    if (key === 'then') return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) => {
      const sql = (target as unknown as { toSQL(): { sql: string } }).toSQL().sql;
      return (target as unknown as PromiseLike<unknown>).then(rows => {
        reads.push({ sql, rows: Array.isArray(rows) ? rows.length : 1 });
        return resolve(rows);
      }, reject);
    };
    return (...args: unknown[]) => {
      const result = (value as (...a: unknown[]) => unknown).apply(target, args);
      return result === target ? receiver : typeof result === 'object' && result !== null && 'toSQL' in result ? watch(result) : result;
    };
  } });
  return (gymId, fn) => db.forGym(gymId, tx => fn(new Proxy(tx, { get(target, key) {
    const value = Reflect.get(target, key) as unknown;
    if ((key === 'select' || key === 'selectDistinct') && typeof value === 'function')
      return (...args: unknown[]) => watch((value as (...a: unknown[]) => object).apply(target, args));
    return typeof value === 'function' ? value.bind(target) : value;
  } })));
}

it.each([false, true])('bounds recovered cancellation decision reads even with unrelated session history (shared address %s)', async shared => {
  const gymId = uuidv7(), clock = new TestClock('2026-11-10T12:00:00Z'), size = 25;
  await factory('gyms', gymId, { memberEmailsEnabled: true });
  const household = await factory('households', gymId), session = await factory('classSessions', gymId, { status: 'cancelled' });
  const people = await db.forGym(gymId, tx => tx.insert(members).values(Array.from({ length: size }, (_, i) => ({
    gymId, householdId: household.id, firstName: 'Bulk', lastName: String(i), email: `member${shared ? 0 : i}@example.test`,
  }))).returning({ id: members.id }));
  await db.forGym(gymId, tx => tx.insert(emailDeliveries).values(people.map((person, i) => ({
    gymId, key: `schedule-cancel-notice:${session.id}:${person.id}`, state: 'not_accepted', updatedAt: clock.now(),
    commandDigest: commandDigest([session.id, `member${shared ? 0 : i}@example.test`]),
  }))));
  await db.forGym(gymId, tx => tx.insert(auditEvents).values(Array.from({ length: size * 5 }, (_, i) => ({
    gymId, actorKind: 'system', action: 'schedule.cancellation_notice_decided', targetType: 'class_session', targetId: session.id,
    after: { memberId: people[i]?.id ?? uuidv7(), status: 'failed', reason: 'not_accepted' }, occurredAt: clock.now(),
  }))));
  const reads: Read[] = [], email = new FakeEmail();
  const service = createCancellationNotice({ scope: recording(reads), clock, jobs: new FakeJobs(clock), demoMode: false,
    origin: async () => 'https://gym.example.test', mailer: async () => email });
  const payload = { sessionId: session.id, memberIds: people.map(person => person.id), note: '' };
  await service.run(payload, gymId); await service.run(payload, gymId);
  const decisions = reads.filter(read => read.sql.includes('from "audit_events"'));
  expect(decisions).toHaveLength(shared ? 2 : size * 2);
  expect(decisions.every(read => read.rows === (shared ? size : 1) && read.sql.includes("->>'memberId'") && read.sql.includes(' in ('))).toBe(true);
  expect(email.messages).toHaveLength(0);
  expect(await db.forGym(gymId, tx => tx.$count(auditEvents))).toBe(size * 5);
});

it.each([25, 250])('bounds recipient reads and rank rows in a %i-member send', async size => {
  const gymId = uuidv7(), clock = new TestClock('2026-11-10T12:00:00Z');
  await factory('gyms', gymId, { memberEmailsEnabled: true });
  const household = await factory('households', gymId), user = await factory('authUser', gymId);
  await factory('staffRoles', gymId, { userId: user.id, role: 'owner' });
  const system = await factory('rankSystems', gymId), rank = await factory('ranks', gymId, { rankSystemId: system.id });
  const program = await factory('programs', gymId, { rankSystemId: system.id });
  const people = await db.forGym(gymId, tx => tx.insert(members).values(Array.from({ length: size }, (_, i) => ({
    gymId, householdId: household.id, firstName: 'Bulk', lastName: String(i), status: 'active', email: `member${i}@example.test`,
  }))).returning({ id: members.id }));
  await db.forGym(gymId, tx => tx.insert(memberRanks).values(people.map(person => ({ gymId, memberId: person.id,
    programId: program.id, rankId: rank.id, rankSystemId: system.id, promotedAt: clock.now() }))));
  const reads: Read[] = [], email = new FakeEmail();
  const service = createAnnouncementsService({ scope: recording(reads), clock, jobs: new FakeJobs(clock),
    smtp: { configured: async () => true }, mailer: async () => { expect(isInTransaction()).toBe(false); return email; },
    origin: async () => 'https://gym.example.test', senderEmail: async () => user.email });
  const row = await service.send({ gymId, userId: user.id }, { ...announcementDraftSchema.parse({ subject: 'Notice', body: 'See you soon',
    audience: { statuses: ['active'], programIds: [program.id] } }), confirm: true, sendGeneration: uuidv7() });
  reads.length = 0;
  await service.run({ announcementId: row.id }, gymId);
  expect(email.messages).toHaveLength(size);
  expect(new Set(email.messages.map(message => message.to)).size).toBe(size);
  const groups = reads.filter(read => read.sql.includes('left join "announcement_opt_outs"'));
  const ranks = reads.filter(read => read.sql.includes('from "member_ranks"'));
  expect(groups).toHaveLength(size); expect(ranks).toHaveLength(size);
  expect(groups.every(read => read.rows === 1 && read.sql.includes('"members"."email_address"') && !read.sql.includes('ilike'))).toBe(true);
  expect(ranks.every(read => read.rows === 1 && read.sql.includes('"member_ranks"."member_id" in'))).toBe(true);
  expect(reads.length).toBeLessThanOrEqual(size * 14 + 10);
  expect(reads.reduce((total, read) => total + read.rows, 0)).toBeLessThanOrEqual(size * 15 + 60);
  console.info(`Announcement scale: ${size} recipients, ${reads.length} SELECTs, ${reads.reduce((total, read) => total + read.rows, 0)} returned rows`);
}, 90_000);

it.each([25, 250])('bounds cancellation address reads with %i recipients and unrelated member and delivery history', async size => {
  const gymId = uuidv7(), clock = new TestClock('2026-11-10T12:00:00Z');
  await factory('gyms', gymId, { memberEmailsEnabled: true });
  const household = await factory('households', gymId);
  const session = await factory('classSessions', gymId, { status: 'cancelled' });
  const people = await db.forGym(gymId, tx => tx.insert(members).values(Array.from({ length: size * 4 }, (_, i) => ({
    gymId, householdId: household.id, firstName: 'Bulk', lastName: String(i), status: 'active', email: `member${i}@example.test`,
  }))).returning({ id: members.id }));
  await db.forGym(gymId, tx => tx.insert(emailDeliveries).values(Array.from({ length: size * 4 }, (_, i) => ({
    gymId, key: `unrelated:${i}`, commandDigest: `unrelated:${i}`, state: 'accepted', attempts: 1, createdAt: clock.now(), updatedAt: clock.now(),
  }))));
  const reads: Read[] = [], email = new FakeEmail();
  const service = createCancellationNotice({ scope: recording(reads), clock, jobs: new FakeJobs(clock), demoMode: false,
    mailer: async () => { expect(isInTransaction()).toBe(false); return email; }, origin: async () => 'https://gym.example.test' });
  await service.run({ sessionId: session.id, memberIds: people.slice(0, size).map(person => person.id), note: 'Closed' }, gymId);
  expect(email.messages).toHaveLength(size);
  const groups = reads.filter(read => read.sql.includes('left join "announcement_opt_outs"'));
  expect(groups).toHaveLength(size * 2);
  expect(groups.every(read => read.rows === 1 && read.sql.includes('"members"."email_address" =') && !read.sql.includes('ilike'))).toBe(true);
  const history = reads.filter(read => read.sql.includes('from "email_deliveries"'));
  expect(history.every(read => read.rows === 0 && read.sql.includes('"email_deliveries"."command_digest" ='))).toBe(true);
  expect(reads.reduce((total, read) => total + read.rows, 0)).toBeLessThanOrEqual(size * 10 + 20);
  console.info(`Cancellation scale: ${size} recipients, ${reads.length} SELECTs, ${reads.reduce((total, read) => total + read.rows, 0)} returned rows`);
}, 90_000);

it('bounds cancellation email reads for 50 billing addresses with five members each', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-11-10T12:00:00Z');
  await factory('gyms', gymId, { memberEmailsEnabled: true });
  const unrelated = await factory('households', gymId);
  const session = await factory('classSessions', gymId, { status: 'cancelled' });
  const homes = Array.from({ length: 50 }, (_, i) => ({
    id: uuidv7(), name: `Home ${i}`, email: `home${i}@example.test`,
    people: Array.from({ length: 5 }, (_, n) => ({ firstName: `H${i}`, lastName: `M${n}` })),
  }));
  const people = await db.forGym(gymId, async tx => {
    await tx.insert(households).values(homes.map(({ id, name, email }) => ({ id, gymId, name, email })));
    await tx.insert(members).values(Array.from({ length: 1_000 }, (_, i) => ({
      gymId, householdId: unrelated.id, firstName: 'Unrelated', lastName: String(i), email: `unrelated${i}@example.test`,
    })));
    return tx.insert(members).values(homes.flatMap(home => home.people.map(person => ({
      ...person, gymId, householdId: home.id,
    })))).returning({ id: members.id });
  });
  const reads: Read[] = [], email = new FakeEmail();
  const service = createCancellationNotice({ scope: recording(reads), clock, jobs: new FakeJobs(clock), demoMode: false,
    mailer: async () => email, origin: async () => 'https://gym.example.test' });
  await service.run({ sessionId: session.id, memberIds: people.map(person => person.id), note: '' }, gymId);

  expect(email.messages).toHaveLength(homes.length);
  const byAddress = new Map(email.messages.map(message => [message.to, message.text]));
  for (const home of homes) {
    const names = byAddress.get(home.email)?.match(/^Booked or waitlisted members: (.+)$/m)?.[1]?.split(', ').sort();
    expect(names).toEqual(home.people.map(person => `${person.firstName} ${person.lastName}`));
  }
  expect(reads.some(read => read.sql.includes('btrim('))).toBe(false);
  const total = reads.reduce((rows, read) => rows + read.rows, 0);
  expect(total).toBeLessThanOrEqual(250 * 10 + 20);
  console.info(`Cancellation billing email scale: ${reads.length} SELECTs, ${total} returned rows`);
}, 90_000);

it('bounds cancellation text rechecks to the members at each of 250 phones', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-11-10T12:00:00Z'), size = 250;
  await factory('gyms', gymId, { name: 'Cedar Gym', memberEmailsEnabled: false, memberSmsEnabled: true,
    settings: { address: { country: 'US' } } });
  const home = await factory('households', gymId);
  const session = await factory('classSessions', gymId, { status: 'cancelled' });
  const phones = Array.from({ length: size }, (_, i) => `+1202555${1000 + i}`);
  const people = await db.forGym(gymId, tx => tx.insert(members).values(phones.map((phone, i) => ({
    gymId, householdId: home.id, firstName: 'Bulk', lastName: String(i), phone, phoneE164: phone,
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff',
  }))).returning({ id: members.id }));
  const reads: Read[] = [], sms = new FakeSms();
  const resolver = {
    resolve: async (id: string) => { expect(isInTransaction()).toBe(false); return { gymId: id, name: 'Cedar Gym', sms }; },
    status: async () => ({ source: 'gym' as const, unreadable: false }), configured: async () => true,
  };
  const service = createCancellationNotice({ scope: recording(reads), clock, jobs: new FakeJobs(clock), demoMode: false,
    mailer: async () => null, origin: async () => 'https://gym.example.test',
    sms: { resolver, phoneDigest: createSmsPhoneDigest('class-notice-test') } });
  await service.run({ sessionId: session.id, memberIds: people.map(person => person.id), note: '' }, gymId);

  expect(sms.messages.map(message => message.to).sort()).toEqual(phones);
  const rosterReads = reads.filter(read => read.rows > 10);
  expect(rosterReads.length).toBeGreaterThan(0);
  expect(rosterReads.length).toBeLessThanOrEqual(3);
  // Only roster reads of the members return many rows, wherever they fall among the SELECTs.
  expect(rosterReads.every(read => read.sql.includes('from "members"'))).toBe(true);
  const total = reads.reduce((rows, read) => rows + read.rows, 0);
  // Bounded per phone across reservation, pre-resolution read, and the cap transaction's locked last check.
  expect(total).toBeLessThan(size * 22);
  console.info(`Cancellation text scale: ${reads.length} SELECTs, ${total} returned rows`);
}, 90_000);

it('bounds restore text rechecks to the members at each of 250 phones', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-11-10T12:00:00Z'), size = 250;
  await factory('gyms', gymId, { name: 'Cedar Gym', memberEmailsEnabled: false, memberSmsEnabled: true,
    settings: { address: { country: 'US' } } });
  const user = await factory('authUser', gymId), home = await factory('households', gymId);
  const session = await factory('classSessions', gymId, { status: 'scheduled', restoreCount: 1,
    startsAt: new Date('2026-11-11T00:30:00Z'), endsAt: new Date('2026-11-11T01:30:00Z') });
  const phones = Array.from({ length: size }, (_, i) => `+1202555${1000 + i}`);
  const people = await db.forGym(gymId, tx => tx.insert(members).values(phones.map((phone, i) => ({
    gymId, householdId: home.id, firstName: 'Bulk', lastName: String(i), phone, phoneE164: phone,
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff',
  }))).returning({ id: members.id }));
  await db.forGym(gymId, tx => tx.insert(classBookings).values(people.map(person => ({
    gymId, sessionId: session.id, memberId: person.id, bookedBy: user.id, bookedByKind: 'staff', status: 'booked',
  }))));
  const reads: Read[] = [], sms = new FakeSms();
  const resolver = {
    resolve: async (id: string) => { expect(isInTransaction()).toBe(false); return { gymId: id, name: 'Cedar Gym', sms }; },
    status: async () => ({ source: 'gym' as const, unreadable: false }), configured: async () => true,
  };
  const service = createRestoreNotice({ scope: recording(reads), clock, jobs: new FakeJobs(clock), demoMode: false,
    mailer: async () => null, origin: async () => 'https://gym.example.test',
    sms: { resolver, phoneDigest: createSmsPhoneDigest('restore-notice-test') } });
  await service.run({ sessionId: session.id, memberIds: people.map(person => person.id), round: 1, channels: ['sms'] }, gymId);

  expect(sms.messages.map(message => message.to).sort()).toEqual(phones);
  const rosterReads = reads.filter(read => read.rows > 10);
  expect(rosterReads.length).toBeGreaterThan(0);
  expect(rosterReads.length).toBeLessThanOrEqual(4);
  expect(rosterReads.every(read => read.sql.includes('from "members"') || read.sql.includes('from "class_bookings"'))).toBe(true);
  const total = reads.reduce((rows, read) => rows + read.rows, 0);
  expect(total).toBeLessThan(size * 26);
  console.info(`Restore text scale: ${reads.length} SELECTs, ${total} returned rows, ${rosterReads.length} reads > 10 rows`);
}, 90_000);
