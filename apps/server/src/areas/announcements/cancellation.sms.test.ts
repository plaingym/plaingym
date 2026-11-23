// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Isolated fixtures exercise the persisted independent member SMS switch.
import { emailDeliveries, gyms, households, members, smsDeliveries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createSmsPhoneDigest, DeliveryError, FakeSms } from '../../infra/sms/index.js';
import { smsInFlightMs } from '../../infra/sms/deliveries.js';
import { createScheduleService } from '../schedule/schedule.js';
import { createMembersService } from '../members/members.js';
import { idSchema } from '@plaingym/shared/contracts';
import { z } from 'zod';
import { cancellationNoticeJob, cancellationNoticeJobPayload, createCancellationNotice } from './cancellation.js';
import { createAnnouncementJobs } from './jobs.js';
import { announcementRecoveryJob, createAnnouncementRecoveryJobs } from './recovery.js';

const db = useTestDatabase(), factory = createFactories(db), phone = '+12025550123';
const digest = createSmsPhoneDigest('class-notice-test');
const selfText = 'Cedar Gym: Evening practice on 2026-11-10 at 7:30 PM EST has been cancelled.';
async function fixture(recurring = false, channels?: ('email' | 'sms')[]) {
  const gymId = uuidv7(), clock = new TestClock('2026-11-10T12:00:00Z');
  await factory('gyms', gymId, { name: 'Cedar Gym', settings: { address: { country: 'US' } }, timezone: 'America/New_York', memberEmailsEnabled: true, memberSmsEnabled: true });
  const user = await factory('authUser', gymId);
  await factory('staffRoles', gymId, { userId: user.id, role: 'owner' });
  const home = await factory('households', gymId, { email: ' PARENT@example.test ', phone, phoneE164: phone,
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
  const children = [];
  for (const firstName of ['Mia', 'Noa', 'Ari']) children.push(await factory('members', gymId, { householdId: home.id, firstName }));
  const template = recurring ? await factory('classTemplates', gymId) : undefined;
  const session = await factory('classSessions', gymId, { name: 'Evening practice', templateId: template?.id ?? null,
    startsAt: new Date('2026-11-11T00:30:00Z'), endsAt: new Date('2026-11-11T01:30:00Z') });
  await factory('classSessionPrograms', gymId, { sessionId: session.id });
  for (const child of children) await factory('classBookings', gymId, { memberId: child.id, sessionId: session.id, bookedBy: user.id });
  const email = new FakeEmail(), sms = new FakeSms(), jobs = new FakeJobs(clock);
  const resolver = { resolve: vi.fn(async (id: string) => { expect(isInTransaction()).toBe(false); return { gymId: id, name: 'Cedar Gym', sms }; }),
    status: async () => ({ source: 'gym' as const, unreadable: false }), configured: async () => true };
  const options = { scope: db.forGym, clock, jobs, mailer: async () => email, origin: async () => 'https://gym.example.test',
    demoMode: false, sms: { resolver, phoneDigest: digest } };
  const notice = createCancellationNotice(options), schedule = createScheduleService({ scope: db.forGym, clock, cancellation: notice });
  createServerRegistry({ jobs: createAnnouncementJobs(undefined, () => notice) }).registerJobs(jobs, new Set());
  await schedule.changeSession({ gymId, actor: { kind: 'user', userId: user.id } }, session.id, 'cancel', { revision: 1, notify: true, ...(channels ? { channels } : {}) });
  const payload ={ sessionId: session.id, memberIds: children.map(child => child.id), note: '' };
  return { gymId, clock, user, home, children, session, email, sms, jobs, resolver, options, notice, schedule, payload,
    run: () => notice.run(payload, gymId) };
}

it('texts a cancellation after a restore under its scoped key, and never the one from before the restore', async () => {
  const f = await fixture(), actor = { gymId: f.gymId, actor: { kind: 'user' as const, userId: f.user.id } };
  const first = f.jobs.jobs.find(job => job.name === cancellationNoticeJob)!.payload;
  await f.schedule.restoreSession(actor, f.session.id, { revision: 2 });
  await f.schedule.changeSession(actor, f.session.id, 'cancel', { revision: 3, notify: true, channels: ['sms'] });
  await f.notice.run(first, f.gymId);
  expect(f.sms.messages).toHaveLength(0); expect(f.email.messages).toHaveLength(0);
  const second = f.jobs.jobs.filter(job => job.name === cancellationNoticeJob)[1]!;
  expect(second.options.idempotencyKey).toBe(`schedule-cancel-notice:${f.session.id}.1`);
  await f.notice.run(second.payload, f.gymId); await f.notice.run(second.payload, f.gymId);
  expect(f.sms.messages).toHaveLength(1); expect(f.email.messages).toHaveLength(0);
  const stored = await db.forGym(f.gymId, tx => tx.select().from(smsDeliveries));
  expect(stored).toMatchObject([{ key: `schedule-cancel-sms:${f.session.id}.1:${f.children[0]!.id}`, state: 'accepted',
    commandDigest: `schedule-cancel-sms:${f.session.id}.1:${digest(phone)}` }]);
});

it.each([false, true])('a cancelled class (recurring=%s) sends its parent one email and one text naming three children, once', async recurring => {
  const f = await fixture(recurring);
  expect(await f.jobs.runNext()).toBe(true);
  await Promise.allSettled([f.run(), f.run()]); await f.run();
  expect(f.email.messages).toHaveLength(1); expect(f.email.messages[0]!.to).toBe('parent@example.test');
  expect(f.sms.messages).toHaveLength(1);
  expect(f.sms.messages[0]!.to).toBe(phone);
  expect(f.sms.messages[0]!.body).toMatch(/^Cedar Gym: /);
  for (const name of ['Mia', 'Noa', 'Ari']) {
    expect(f.email.messages[0]!.text).toContain(name); expect(f.sms.messages[0]!.body).toContain(name);
  }
  for (const value of ['Evening practice', '2026-11-10', '7:30 PM EST']) expect(f.sms.messages[0]!.body).toContain(value);
  const [stored] = await db.forGym(f.gymId, tx => tx.select().from(smsDeliveries));
  expect(stored).toMatchObject({ key: `schedule-cancel-sms:${f.session.id}:${f.children[0]!.id}`, state: 'accepted' });
  expect(stored!.commandDigest).toContain(digest(phone));
  expect(JSON.stringify(stored)).not.toContain(phone);
});

it.each(['none', 'announcements'] as const)('never texts a phone with %s consent alone, while its email still sends', async consent => {
  const f = await fixture();
  await db.forGym(f.gymId, async tx => {
    await tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id));
    for (const child of f.children) await tx.update(members).set({ phone, phoneE164: phone,
      ...(consent === 'announcements' ? { smsAnnouncementsConsentAt: f.clock.now(), smsAnnouncementsConsentSource: 'portal' } : {}) }).where(eq(members.id, child.id));
  });
  await f.run(); expect(f.sms.messages).toHaveLength(0); expect(f.email.messages).toHaveLength(1);
});

it('prefers a member consented phone and own email, and names only the other children on the parent notice', async () => {
  const f = await fixture(), child = f.children[0]!, own = '+12025550199';
  await db.forGym(f.gymId, tx => tx.update(members).set({ phone: own, phoneE164: own, email: 'mia@example.test',
    smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, child.id)));
  await f.run(); expect(f.sms.messages).toHaveLength(2); expect(f.email.messages).toHaveLength(2);
  // Her own phone covers only her, so her text leaves the names out.
  expect(f.sms.messages.find(message => message.to === own)!.body).toBe(selfText);
  expect(f.sms.messages.find(message => message.to === phone)!.body).not.toContain('Mia');
  expect(f.email.messages.find(message => message.to === 'parent@example.test')!.text).not.toContain('Mia');
});

it('texts and emails nobody on a channel staff didn’t choose', async () => {
  const f = await fixture();
  await f.notice.run(cancellationNoticeJobPayload({ ...f.payload, channels: ['email'] }), f.gymId);
  expect(f.email.messages).toHaveLength(1); expect(f.sms.messages).toHaveLength(0);
  expect(f.resolver.resolve).not.toHaveBeenCalled();
  expect(await db.forGym(f.gymId, tx => tx.$count(smsDeliveries))).toBe(0);
  const g = await fixture();
  await g.notice.run(cancellationNoticeJobPayload({ ...g.payload, channels: ['sms'] }), g.gymId);
  expect(g.sms.messages).toHaveLength(1); expect(g.email.messages).toHaveLength(0);
  expect(await db.forGym(g.gymId, tx => tx.$count(emailDeliveries))).toBe(0);
});

it.each(['email', 'sms'] as const)('a previous release refuses a %s-only notice, and recovery sends only that channel after the upgrade', async channel => {
  const f = await fixture(false, [channel]);
  const queued = f.jobs.jobs.find(job => job.name === cancellationNoticeJob)!;
  expect(queued.payload).toMatchObject({ channels: [channel], notice: { sessionId: f.session.id, note: '' } });
  expect(queued.payload).not.toHaveProperty('sessionId');
  expect(new Set((queued.payload as { notice: { memberIds: string[] } }).notice.memberIds)).toEqual(new Set(f.payload.memberIds));
  // The previous release's handler: its parser drops keys it doesn't know, and it then sends both channels.
  const previous = z.object({ sessionId: idSchema, memberIds: z.array(idSchema), note: z.string().max(1_000) });
  const current = createAnnouncementJobs(undefined, () => f.notice).find(job => job.id === cancellationNoticeJob)!;
  let release: 'previous' | 'current' = 'previous';
  const jobs = new FakeJobs(f.clock);
  jobs.handle(cancellationNoticeJob, async (payload, context) => release === 'previous'
    ? f.notice.run(previous.parse(payload), context.gymId) : current.handler(payload, context));
  createServerRegistry({ jobs: createAnnouncementRecoveryJobs({ scope: db.forGym, clock: f.clock, jobs }) }).registerJobs(jobs, new Set());
  await jobs.enqueue(cancellationNoticeJob, queued.payload, queued.options);
  const job = () => jobs.jobs.find(item => item.name === cancellationNoticeJob)!;
  for (let attempt = 1; attempt <= 12; attempt++) {
    expect(await jobs.runNext()).toBe(true);
    expect(job().attempt).toBe(attempt); f.clock.set(job().runAt);
  }
  expect(job().status).toBe('failed');
  expect(f.email.messages).toHaveLength(0); expect(f.sms.messages).toHaveLength(0);
  expect(await db.forGym(f.gymId, tx => tx.$count(emailDeliveries))).toBe(0);
  expect(await db.forGym(f.gymId, tx => tx.$count(smsDeliveries))).toBe(0);
  // After the upgrade, recovery retries the original job with its original payload.
  release = 'current'; f.clock.advance(15 * 60_000);
  await jobs.triggerSchedule(announcementRecoveryJob, [{ gymId: f.gymId, timezone: 'UTC' }], 'recover-1');
  expect(await jobs.runNext()).toBe(true);
  expect(job()).toMatchObject({ status: 'queued', attempt: 0, payload: queued.payload });
  expect(await jobs.runNext()).toBe(true);
  expect(job().status).toBe('completed');
  expect(f.email.messages).toHaveLength(channel === 'email' ? 1 : 0);
  expect(f.sms.messages).toHaveLength(channel === 'sms' ? 1 : 0);
  if (channel === 'email') expect(await db.forGym(f.gymId, tx => tx.$count(smsDeliveries))).toBe(0);
  else expect(await db.forGym(f.gymId, tx => tx.$count(emailDeliveries))).toBe(0);
});

it('stores a notice for both channels in the flat shape a previous release sends by both', async () => {
  const f = await fixture(false, ['email', 'sms']);
  const queued = f.jobs.jobs.find(job => job.name === cancellationNoticeJob)!;
  expect(queued.payload).toMatchObject({ sessionId: f.session.id, note: '' });
  expect(queued.payload).not.toHaveProperty('channels');
  await f.notice.run(queued.payload, f.gymId);
  expect(f.email.messages).toHaveLength(1); expect(f.sms.messages).toHaveLength(1);
});

it.each([[['email', 'sms']], [['sms', 'email']], [undefined]] as const)('sends both channels for channels %j', async channels => {
  const f = await fixture();
  await f.notice.run({ ...f.payload, ...(channels ? { channels } : {}) }, f.gymId);
  expect(f.email.messages).toHaveLength(1); expect(f.sms.messages).toHaveLength(1);
});

it('leaves the names out for one member at their own email and own consented phone', async () => {
  const f = await fixture(), own = '+12025550177';
  const home = await factory('households', f.gymId, { email: 'solo-home@example.test' });
  const solo = await factory('members', f.gymId, { householdId: home.id, firstName: 'Solo', lastName: 'Member',
    email: 'solo@example.test', phone: own, phoneE164: own, smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' });
  await f.notice.run({ ...f.payload, memberIds: [solo.id] }, f.gymId);
  expect(f.email.messages).toHaveLength(1); expect(f.email.messages[0]!.to).toBe('solo@example.test');
  expect(f.email.messages[0]!.text).not.toContain('Booked or waitlisted members');
  expect(f.email.messages[0]!.text).not.toContain('Solo');
  expect(f.sms.messages).toHaveLength(1); expect(f.sms.messages[0]!.to).toBe(own);
  expect(f.sms.messages[0]!.body).toBe(selfText);
});

it('names both children on the parent’s household address and billing phone', async () => {
  const f = await fixture(), [mia, noa] = f.children;
  await f.notice.run({ ...f.payload, memberIds: [mia!.id, noa!.id] }, f.gymId);
  expect(f.email.messages).toHaveLength(1); expect(f.sms.messages).toHaveLength(1);
  const line = f.email.messages[0]!.text.match(/^Booked or waitlisted members: (.+)$/m)?.[1];
  const names = f.sms.messages[0]!.body.match(/ Members: (.+)\.$/)?.[1];
  for (const listed of [line, names]) {
    for (const name of ['Mia', 'Noa']) expect(listed).toContain(name);
    expect(listed).not.toContain('Ari');
  }
});

it('names the one child a parent’s billing phone and address cover', async () => {
  const f = await fixture(), [mia] = f.children;
  await f.notice.run({ ...f.payload, memberIds: [mia!.id] }, f.gymId);
  expect(f.email.messages[0]!.to).toBe('parent@example.test');
  expect(f.email.messages[0]!.text).toMatch(/^Booked or waitlisted members: .*Mia/m);
  expect(f.sms.messages[0]!.to).toBe(phone); expect(f.sms.messages[0]!.body).toMatch(/Members: .*Mia/);
});

it.each(['roster read', 'reservation'] as const)('leaves a member out after they withdraw notices consent after the %s', async phase => {
  const f = await fixture(), child = f.children[1]!;
  const home = await factory('households', f.gymId);
  await db.forGym(f.gymId, tx => tx.update(members).set({ householdId: home.id, phone, phoneE164: phone,
    smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, child.id)));

  let withdrawn = false;
  const scope: typeof db.forGym = async (gymId, fn) => {
    const result = await db.forGym(gymId, fn);
    const afterRosterRead = Array.isArray(result) && result.some(row => row.phoneE164 === phone && row.memberIds?.includes(child.id));
    const afterReservation = result && typeof result === 'object' && 'memberIds' in result && 'reserved' in result;
    if (!withdrawn && (phase === 'roster read' ? afterRosterRead : afterReservation)) {
      withdrawn = true;
      await db.forGym(gymId, tx => tx.update(members).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null })
        .where(eq(members.id, child.id)));
    }
    return result;
  };
  await createCancellationNotice({ ...f.options, scope }).run(f.payload, f.gymId);
  expect(withdrawn).toBe(true);
  expect(f.sms.messages).toHaveLength(1);
  expect(f.sms.messages[0]!.to).toBe(phone);
  expect(f.sms.messages[0]!.body).toContain('Mia');
  expect(f.sms.messages[0]!.body).toContain('Ari');
  expect(f.sms.messages[0]!.body).not.toContain('Noa');
});

it('keeps the SMS and email switches independent and rechecks SMS after provider resolution', async () => {
  const f = await fixture();
  await db.forGym(f.gymId, tx => tx.update(gyms).set({ memberSmsEnabled: false }).where(eq(gyms.id, f.gymId)));
  await f.run(); expect(f.sms.messages).toHaveLength(0); expect(f.email.messages).toHaveLength(1);
  await db.forGym(f.gymId, tx => tx.update(gyms).set({ memberSmsEnabled: true, memberEmailsEnabled: false }).where(eq(gyms.id, f.gymId)));
  await f.run(); expect(f.sms.messages).toHaveLength(1); expect(f.email.messages).toHaveLength(1);
  const g = await fixture();
  g.resolver.resolve.mockImplementation(async id => {
    await db.forGym(id, tx => tx.update(gyms).set({ memberSmsEnabled: false }).where(eq(gyms.id, id)));
    return { gymId: id, name: 'Cedar Gym', sms: g.sms };
  });
  await g.run(); expect(g.sms.messages).toHaveLength(0);
});

it.each(['accepted', 'unknown', 'sending'] as const)('never resends a stored %s text, even when the parent phone changes', async state => {
  const f = await fixture();
  await factory('smsDeliveries', f.gymId, { key: `schedule-cancel-sms:${f.session.id}:${f.children[0]!.id}`,
    commandDigest: `schedule-cancel-sms:${f.session.id}:${digest(phone)}`, state,
    updatedAt: new Date(f.clock.now().getTime() - smsInFlightMs) });
  await db.forGym(f.gymId, tx => tx.update(households).set({ phone: '+12025550199', phoneE164: '+12025550199' }).where(eq(households.id, f.home.id)));
  await f.run(); await f.run(); expect(f.sms.messages).toHaveLength(0); expect(f.email.messages).toHaveLength(1);
});

it('does not resend after a crash after the provider sends but before its outcome commits', async () => {
  const f = await fixture(); let broken = true;
  const scope: typeof db.forGym = (id, fn) => broken && f.sms.messages.length ? Promise.reject(new Error('Database unavailable')) : db.forGym(id, fn);
  const interrupted = createCancellationNotice({ ...f.options, scope });
  await expect(interrupted.run(f.payload, f.gymId)).rejects.toThrow();
  expect(f.sms.messages).toHaveLength(1);
  broken = false;
  await expect(interrupted.run(f.payload, f.gymId)).rejects.toMatchObject({ code: 'conflict' });
  f.clock.advance(smsInFlightMs); await interrupted.run(f.payload, f.gymId);
  expect(f.sms.messages).toHaveLength(1); expect(f.email.messages).toHaveLength(1);
});

it('retries a definite non-send without repeating email; an unknown outcome never sends again', async () => {
  for (const acceptance of ['not_accepted', 'unknown'] as const) {
    const f = await fixture(); f.sms.respondNext(new DeliveryError(acceptance, 'Provider reply lost'));
    await expect(f.run()).rejects.toThrow(); await f.run(); await f.run();
    expect(f.sms.messages).toHaveLength(acceptance === 'unknown' ? 0 : 1);
    expect(f.email.messages).toHaveLength(1);
  }
});

it('deduplicates the parent destination after the original first child leaves the group', async () => {
  const f = await fixture(); await f.run();
  await db.forGym(f.gymId, tx => tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, f.children[0]!.id)));
  await f.run(); expect(f.sms.messages).toHaveLength(1);
});

it.each([false, true])('erases the cancellation phone digest and prevents replay (legacy=%s)', async legacy => {
  const f = await fixture(), foreign = await fixture();
  const person = f.children[0]!, key = `schedule-cancel-sms:${f.session.id}:${person.id}`;
  const commandDigest = `schedule-cancel-sms:${f.session.id}:${digest(phone)}`;
  if (legacy) await factory('smsDeliveries', f.gymId, { key, commandDigest, state: 'accepted' });
  else await f.run();
  await factory('smsDeliveries', foreign.gymId, { key, commandDigest, state: 'accepted' });
  await createMembersService({ scope: db.forGym, clock: f.clock }).eraseMember(
    { gymId: f.gymId, actor: { kind: 'system' } }, person.id, { revision: 1 }, { jobs: f.jobs, timezone: 'America/New_York' });
  await f.run();
  expect(f.sms.messages).toHaveLength(legacy ? 0 : 1);
  const deliveries = (gymId: string) => db.forGym(gymId, tx => tx.select().from(smsDeliveries));
  expect(await deliveries(f.gymId)).toEqual([expect.objectContaining({ key, commandDigest: null, state: 'accepted' })]);
  expect(await deliveries(foreign.gymId)).toEqual([expect.objectContaining({ key, commandDigest })]);
});

it('never includes a different household or gym and refuses a foreign session payload', async () => {
  const f = await fixture(), g = await fixture();
  const other = await factory('households', f.gymId, { email: 'other@example.test', phone: '+12025550198', phoneE164: '+12025550198',
    smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' });
  await factory('members', f.gymId, { householdId: other.id, firstName: 'Unrelated' });
  await f.notice.run({ ...f.payload, memberIds: [...f.payload.memberIds, ...g.payload.memberIds] }, f.gymId);
  expect(f.sms.messages.map(message => message.to)).toEqual([phone]);
  expect(f.email.messages.map(message => message.to)).toEqual(['parent@example.test']);
  expect(f.sms.messages[0]!.body).not.toContain('Unrelated');
  await g.notice.run(f.payload, g.gymId); expect(g.sms.messages).toHaveLength(0); expect(g.email.messages).toHaveLength(0);
});

it('honors billing-email suppression and rechecks household consent after provider resolution', async () => {
  const f = await fixture();
  await factory('members', f.gymId, { householdId: f.home.id, email: f.home.email, emailOptOut: true });
  f.resolver.resolve.mockImplementation(async id => {
    await db.forGym(id, tx => tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id)));
    return { gymId: id, name: 'Cedar Gym', sms: f.sms };
  });
  await f.run(); expect(f.email.messages).toHaveLength(0); expect(f.sms.messages).toHaveLength(0);
});

it('continues to the other phone after an unknown outcome and never repeats either text', async () => {
  const f = await fixture();
  await db.forGym(f.gymId, tx => tx.update(members).set({ phone: '+12025550199', phoneE164: '+12025550199',
    smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, f.children[0]!.id)));
  f.sms.respondNext(new DeliveryError('unknown', 'Provider reply lost'));
  await expect(f.run()).rejects.toThrow();
  expect(f.sms.messages.map(message => message.to)).toEqual(['+12025550199']);
  await f.run(); expect(f.sms.messages).toHaveLength(1); expect(f.email.messages).toHaveLength(1);
  const rows = await db.forGym(f.gymId, tx => tx.select().from(smsDeliveries));
  expect(rows.map(row => row.state).sort()).toEqual(['accepted', 'unknown']);
});

it('uses the same trimmed billing email for discovery and grouping, including legacy Unicode whitespace', async () => {
  const f = await fixture();
  await db.forGym(f.gymId, tx => tx.update(households).set({ email: '\t\u00a0PARENT@example.test\ufeff' }).where(eq(households.id, f.home.id)));
  await f.run(); expect(f.email.messages.map(message => message.to)).toEqual(['parent@example.test']);
  for (const name of ['Mia', 'Noa', 'Ari']) expect(f.email.messages[0]!.text).toContain(name);
});

it('updates the destination digest after a definite non-send so a later group change cannot duplicate the text', async () => {
  const f = await fixture(); f.sms.respondNext(new DeliveryError('not_accepted', 'Provider unavailable'));
  await expect(f.run()).rejects.toThrow();
  await db.forGym(f.gymId, tx => tx.update(households).set({ phone: '+12025550199', phoneE164: '+12025550199' }).where(eq(households.id, f.home.id)));
  await f.run();
  await db.forGym(f.gymId, tx => tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, f.children[0]!.id)));
  await f.run(); expect(f.sms.messages.map(message => message.to)).toEqual(['+12025550199']);
});

it('retries a moved first child on their own phone instead of letting the parent group take their key', async () => {
  const f = await fixture(); f.sms.respondNext(new DeliveryError('not_accepted', 'Provider unavailable'));
  await expect(f.run()).rejects.toThrow();
  // The parent's phone sorts first, so its remaining group is reserved before the moved child's own phone.
  const first = [...f.payload.memberIds].sort()[0]!, own = '+12025550199';
  await db.forGym(f.gymId, tx => tx.update(members).set({ phone: own, phoneE164: own,
    smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, first)));
  await f.run(); await f.run();
  expect(f.sms.messages.map(message => message.to).sort()).toEqual([phone, own]);
});
