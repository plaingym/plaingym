// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Isolated fixtures exercise the persisted independent member SMS switch.
import { emailDeliveries, gyms, households, members, smsDailyUsage, smsDeliveries, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports, database/system-tables -- One extra app-role connection holds the row lock in this disposable test database.
import { openConnection, scopedDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { setLogSink } from '../../core/log.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createSmsPhoneDigest, DeliveryError, FakeSms, SmsRecheckBusy, type Sms } from '../../infra/sms/index.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { smsInFlightMs } from '../../infra/sms/deliveries.js';
import { createScheduleService } from '../schedule/schedule.js';
import { createMembersService } from '../members/members.js';
import { idSchema } from '@plaingym/shared/contracts';
import { z } from 'zod';
import { cancellationNoticeJob, cancellationNoticeJobPayload, createCancellationNotice } from './cancellation.js';
import { forgetErasedAddressDigests } from './erasure.js';
import { createAnnouncementJobs } from './jobs.js';
import { announcementRecoveryJob, createAnnouncementRecoveryJobs } from './recovery.js';
import { createCancellationSms } from './cancellation.sms.js';

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
  const resolver = { resolve: vi.fn(async (id: string) => { expect(isInTransaction()).toBe(false); return { gymId: id, name: 'Cedar Gym', sms: sms as Sms }; }),
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

const usage = (gymId: string) => db.forGym(gymId, tx => tx.select().from(smsDailyUsage));

it.each(['solo', 'household'] as const)('suppresses with phone_changed and no slot when a %s member gains their own consented phone during resolution', async mode => {
  const f = await fixture(), mia = f.children[0]!, own = '+12025550199';
  const notice = mode === 'solo' ? { ...f.payload, memberIds: [mia.id], channels: ['sms'] as const } : { ...f.payload, channels: ['sms'] as const };
  const log = vi.fn(), previousSink = setLogSink(log);
  try {
    f.resolver.resolve.mockImplementationOnce(async id => {
      expect(isInTransaction()).toBe(false);
      await db.forGym(id, tx => tx.update(members).set({ phone: own, phoneE164: own,
        smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, mia.id)));
      return { gymId: id, name: 'Cedar Gym', sms: f.sms };
    });
    await expect(f.notice.run(notice, f.gymId)).rejects.toMatchObject({ acceptance: 'not_accepted' });
    expect(f.sms.messages).toHaveLength(0);
    expect(await usage(f.gymId)).toEqual([]);
    expect(await db.forGym(f.gymId, tx => tx.select({ state: smsDeliveries.state }).from(smsDeliveries)))
      .toEqual([{ state: 'not_accepted' }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"reason":"phone_changed"'));
    // A retry sends each member's text to the right phone without naming Mia on the household phone.
    await f.notice.run(notice, f.gymId);
    if (mode === 'solo') {
      expect(f.sms.messages).toEqual([{ to: own, body: selfText }]);
      expect(await usage(f.gymId)).toEqual([expect.objectContaining({ sent: 1, refused: 0 })]);
    } else {
      expect(f.sms.messages.map(message => message.to).sort()).toEqual([phone, own]);
      expect(f.sms.messages.find(message => message.to === own)!.body).toBe(selfText);
      expect(f.sms.messages.find(message => message.to === phone)!.body).not.toContain('Mia');
      expect(await usage(f.gymId)).toEqual([expect.objectContaining({ sent: 2, refused: 0 })]);
    }
  } finally { setLogSink(previousSink); }
});

it.each(['member_to_household', 'household_to_member'] as const)('accepts one text and one slot when consent switches %s at the same number during resolution', async direction => {
  const f = await fixture(), mia = f.children[0]!;
  const notice = { ...f.payload, memberIds: [mia.id], channels: ['sms'] as const };
  if (direction === 'member_to_household') {
    await db.forGym(f.gymId, tx => tx.update(members).set({ phone, phoneE164: phone,
      smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, mia.id)));
    f.resolver.resolve.mockImplementationOnce(async id => {
      await db.forGym(id, tx => tx.update(members).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(members.id, mia.id)));
      return { gymId: id, name: 'Cedar Gym', sms: f.sms };
    });
  } else {
    f.resolver.resolve.mockImplementationOnce(async id => {
      await db.forGym(id, async tx => {
        await tx.update(members).set({ phone, phoneE164: phone, smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, mia.id));
        await tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id));
      });
      return { gymId: id, name: 'Cedar Gym', sms: f.sms };
    });
  }
  await f.notice.run(notice, f.gymId);
  expect(f.sms.messages.map(message => message.to)).toEqual([phone]);
  expect(await usage(f.gymId)).toEqual([expect.objectContaining({ sent: 1, refused: 0 })]);
});

it.each(['member_to_household', 'household_to_member'] as const)('words the cancellation text for the locked consent holder when consent switches %s at the same number', async direction => {
  const f = await fixture(), mia = f.children[0]!;
  const notice = { ...f.payload, memberIds: [mia.id], channels: ['sms'] as const };
  if (direction === 'member_to_household') {
    await db.forGym(f.gymId, async tx => {
      await tx.update(members).set({ phone, phoneE164: phone,
        smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, mia.id));
      await tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id));
    });
    f.resolver.resolve.mockImplementationOnce(async id => {
      await db.forGym(id, async tx => {
        await tx.update(members).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(members.id, mia.id));
        await tx.update(households).set({ smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(households.id, f.home.id));
      });
      return { gymId: id, name: 'Cedar Gym', sms: f.sms };
    });
  } else {
    f.resolver.resolve.mockImplementationOnce(async id => {
      await db.forGym(id, async tx => {
        await tx.update(members).set({ phone, phoneE164: phone,
          smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, mia.id));
        await tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id));
      });
      return { gymId: id, name: 'Cedar Gym', sms: f.sms };
    });
  }
  await f.notice.run(notice, f.gymId);
  expect(f.sms.messages).toHaveLength(1);
  expect(f.sms.messages[0]!.to).toBe(phone);
  expect(f.sms.messages[0]!.body).toBe(direction === 'member_to_household'
    ? `${selfText} Members: ${mia.firstName} ${mia.lastName}.` : selfText);
  expect(await usage(f.gymId)).toEqual([expect.objectContaining({ sent: 1, refused: 0 })]);
});

it('charges the usage day of the locked timezone when timezone changes during resolution while keeping the job timezone in the body', async () => {
  // 12:00 UTC is 2026-11-10 in New York, but already 2026-11-11 in Kiritimati.
  const f = await fixture();
  f.resolver.resolve.mockImplementationOnce(async id => {
    await db.forGym(id, tx => tx.update(gyms).set({ timezone: 'Pacific/Kiritimati' }).where(eq(gyms.id, id)));
    return { gymId: id, name: 'Cedar Gym', sms: f.sms };
  });
  await f.notice.run({ ...f.payload, channels: ['sms'] }, f.gymId);
  expect(f.sms.messages).toHaveLength(1);
  for (const value of ['2026-11-10', '7:30 PM EST']) expect(f.sms.messages[0]!.body).toContain(value);
  expect(await usage(f.gymId)).toEqual([expect.objectContaining({ day: '2026-11-11', sent: 1, refused: 0 })]);
});

it('gives way on a busy member lock during the last check (no slot taken) until released, then sends once', async () => {
  const f = await fixture();
  let busyCalls = 0;
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), gaveWay = Promise.withResolvers<void>();
  const unblock = setTimeout(() => release.resolve(), 15_000);
  const holderConnection = openConnection(db.appUrl, 1);
  let holder: Promise<void> | undefined, sending: Promise<unknown> | undefined;
  const scope: typeof db.forGym = (id, fn) => db.forGym(id, async tx => {
    try { return await fn(tx); }
    catch (error) {
      if (error instanceof SmsRecheckBusy) { busyCalls++; gaveWay.resolve(); }
      throw error;
    }
  });
  f.resolver.resolve.mockImplementationOnce(async id => {
    holder = scopedDatabase(holderConnection.db).forGym(id, async tx => {
      await tx.select({ id: members.id }).from(members).where(eq(members.id, f.children[0]!.id)).for('update');
      held.resolve();
      await release.promise;
    });
    await Promise.race([held.promise, holder]);
    return { gymId: id, name: 'Cedar Gym', sms: f.sms };
  });
  try {
    sending = createCancellationNotice({ ...f.options, scope }).run({ ...f.payload, channels: ['sms'] }, f.gymId);
    sending.catch(() => undefined);
    await Promise.race([gaveWay.promise, sending]);
    expect(busyCalls).toBeGreaterThanOrEqual(1);
    expect(f.sms.messages).toHaveLength(0);
    expect(await usage(f.gymId)).toEqual([]);
  } finally {
    clearTimeout(unblock);
    release.resolve();
    await Promise.allSettled([holder, sending]);
    await holderConnection.close();
  }
  await Promise.all([holder, sending]);
  expect(f.sms.messages.map(message => message.to)).toEqual([phone]);
  expect(await usage(f.gymId)).toEqual([expect.objectContaining({ sent: 1, refused: 0 })]);
});

it('sends nothing and takes no slot when the session is restored during resolution', async () => {
  const f = await fixture(), actor = { gymId: f.gymId, actor: { kind: 'user' as const, userId: f.user.id } };
  f.resolver.resolve.mockImplementationOnce(async id => {
    await f.schedule.restoreSession(actor, f.session.id, { revision: 2 });
    return { gymId: id, name: 'Cedar Gym', sms: f.sms };
  });
  await f.notice.run({ ...f.payload, channels: ['sms'] }, f.gymId);
  expect(f.sms.messages).toHaveLength(0);
  expect(await usage(f.gymId)).toEqual([]);
  expect(await db.forGym(f.gymId, tx => tx.select({ state: smsDeliveries.state }).from(smsDeliveries)))
    .toEqual([{ state: 'not_accepted' }]);
});

it('texts the remaining member at a shared phone when the other loses notices consent during resolution', async () => {
  const f = await fixture(), [mia, noa] = f.children;
  const otherHome = await factory('households', f.gymId);
  await db.forGym(f.gymId, tx => tx.update(members).set({ householdId: otherHome.id, phone, phoneE164: phone,
    smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, noa!.id)));
  f.resolver.resolve.mockImplementationOnce(async id => {
    expect(isInTransaction()).toBe(false);
    await db.forGym(id, tx => tx.update(members).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null })
      .where(eq(members.id, noa!.id)));
    return { gymId: id, name: 'Cedar Gym', sms: f.sms };
  });
  await f.notice.run({ ...f.payload, memberIds: [mia!.id, noa!.id], channels: ['sms'] }, f.gymId);
  expect(f.sms.messages).toHaveLength(1);
  expect(f.sms.messages[0]!.to).toBe(phone);
  expect(f.sms.messages[0]!.body).toContain('Mia');
  expect(f.sms.messages[0]!.body).not.toContain('Noa');
  expect(await usage(f.gymId)).toEqual([expect.objectContaining({ sent: 1, refused: 0 })]);
});

it.each(['first', 'second'] as const)('fails as not_accepted and regroups on retry when the %s member at a shared household phone gains their own phone during resolution', async order => {
  const f = await fixture(), own = '+12025550199';
  const [first, second] = [f.children[0]!, f.children[1]!].sort((a, b) => (a.id < b.id ? -1 : 1));
  const moved = order === 'first' ? first! : second!;
  const stayed = order === 'first' ? second! : first!;
  const notice = { ...f.payload, memberIds: [first!.id, second!.id], channels: ['sms'] as const };
  f.resolver.resolve.mockImplementationOnce(async id => {
    expect(isInTransaction()).toBe(false);
    await db.forGym(id, tx => tx.update(members).set({ phone: own, phoneE164: own,
      smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(members.id, moved.id)));
    return { gymId: id, name: 'Cedar Gym', sms: f.sms };
  });
  await expect(f.notice.run(notice, f.gymId)).rejects.toMatchObject({ acceptance: 'not_accepted' });
  expect(f.sms.messages).toHaveLength(0);
  expect(await usage(f.gymId)).toEqual([]);
  expect(await db.forGym(f.gymId, tx => tx.select({ state: smsDeliveries.state }).from(smsDeliveries)))
    .toEqual([{ state: 'not_accepted' }]);
  await f.notice.run(notice, f.gymId);
  expect(f.sms.messages.map(message => message.to).sort()).toEqual([phone, own].sort());
  expect(f.sms.messages.find(message => message.to === own)!.body).toBe(selfText);
  const householdText = f.sms.messages.find(message => message.to === phone)!.body;
  expect(householdText).toContain(stayed.firstName);
  expect(householdText).not.toContain(moved.firstName);
  expect(await usage(f.gymId)).toEqual([expect.objectContaining({ sent: 2, refused: 0 })]);
});

type Change = (gymId: string) => Promise<unknown>;
/**
 * Runs `change` right after the first text reservation commits and `afterReread` right after the next transaction,
 * the send-time reread of the group at the phone, counting calls so each runs once.
 */
function afterReservation(change: Change, afterReread?: Change) {
  const calls = { reservation: 0, reread: 0 };
  const scope: typeof db.forGym = async (gymId, fn) => {
    const result = await db.forGym(gymId, fn);
    if (calls.reservation === 1 && !calls.reread && afterReread) { calls.reread++; await afterReread(gymId); }
    else if (!calls.reservation && result && typeof result === 'object' && 'reserved' in result && 'memberIds' in result) {
      calls.reservation++; await change(gymId);
    }
    return result;
  };
  return { scope, calls };
}
const consentedPhone = (f: Awaited<ReturnType<typeof fixture>>, memberId: string, to: string | null) => db.forGym(f.gymId, tx =>
  tx.update(members).set(to ? { phone: to, phoneE164: to, smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }
    : { smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(members.id, memberId)));
const states = (gymId: string) => db.forGym(gymId, tx => tx.select({ key: smsDeliveries.key, state: smsDeliveries.state,
  commandResult: smsDeliveries.commandResult }).from(smsDeliveries));

it('ends the attempt as not_accepted when a reserved member moves to their own phone after the reservation, and the retry texts each phone once', async () => {
  const f = await fixture(), [mia, noa] = f.children, own = '+12025550199';
  const notice = { ...f.payload, memberIds: [mia!.id, noa!.id], channels: ['sms'] as const };
  const { scope, calls } = afterReservation(() => consentedPhone(f, noa!.id, own));
  await expect(createCancellationNotice({ ...f.options, scope }).run(notice, f.gymId)).rejects.toMatchObject({ acceptance: 'not_accepted' });
  expect(calls.reservation).toBe(1);
  expect(f.sms.messages).toHaveLength(0);
  expect((await states(f.gymId)).map(row => row.state)).toEqual(['not_accepted']);
  await f.notice.run(notice, f.gymId); await f.notice.run(notice, f.gymId);
  expect(f.sms.messages.map(message => message.to).sort()).toEqual([phone, own]);
  expect(f.sms.messages.find(message => message.to === own)!.body).toBe(selfText);
  expect(f.sms.messages.find(message => message.to === phone)!.body).toContain('Mia');
  expect(f.sms.messages.find(message => message.to === phone)!.body).not.toContain('Noa');
});

it('ends the attempt as not_accepted, not no_consent, when the whole reserved group moves phone after the reservation', async () => {
  const f = await fixture(), [mia, noa] = f.children, moved = '+12025550199';
  const notice = { ...f.payload, memberIds: [mia!.id, noa!.id], channels: ['sms'] as const };
  const { scope, calls } = afterReservation(gymId => db.forGym(gymId, tx => tx.update(households)
    .set({ phone: moved, phoneE164: moved }).where(eq(households.id, f.home.id))));
  await expect(createCancellationNotice({ ...f.options, scope }).run(notice, f.gymId)).rejects.toMatchObject({ acceptance: 'not_accepted' });
  expect(calls.reservation).toBe(1);
  expect(f.sms.messages).toHaveLength(0);
  expect((await states(f.gymId)).map(row => row.state)).toEqual(['not_accepted']);
  await f.notice.run(notice, f.gymId); await f.notice.run(notice, f.gymId);
  expect(f.sms.messages.map(message => message.to)).toEqual([moved]);
  expect(f.sms.messages[0]!.body).toContain('Mia'); expect(f.sms.messages[0]!.body).toContain('Noa');
});

it('ends the attempt as not_accepted when a reserved member left out of the reread is back at the phone for the last check', async () => {
  const f = await fixture(), [mia, noa] = f.children;
  const otherHome = await factory('households', f.gymId);
  await db.forGym(f.gymId, tx => tx.update(members).set({ householdId: otherHome.id }).where(eq(members.id, noa!.id)));
  await consentedPhone(f, noa!.id, phone);
  const notice = { ...f.payload, memberIds: [mia!.id, noa!.id], channels: ['sms'] as const };
  const { scope, calls } = afterReservation(() => consentedPhone(f, noa!.id, null), () => consentedPhone(f, noa!.id, phone));
  await expect(createCancellationNotice({ ...f.options, scope }).run(notice, f.gymId)).rejects.toMatchObject({ acceptance: 'not_accepted' });
  expect(calls).toEqual({ reservation: 1, reread: 1 });
  expect(f.sms.messages).toHaveLength(0);
  expect((await states(f.gymId)).map(row => row.state)).toEqual(['not_accepted']);
  await f.notice.run(notice, f.gymId); await f.notice.run(notice, f.gymId);
  expect(f.sms.messages.map(message => message.to)).toEqual([phone]);
  expect(f.sms.messages[0]!.body).toContain('Mia'); expect(f.sms.messages[0]!.body).toContain('Noa');
});

it('records whom a narrowed text named, so a first member it left out is texted under a key of their own on the retry', async () => {
  const f = await fixture(), [first, second] = [f.children[0]!, f.children[1]!].sort((a, b) => (a.id < b.id ? -1 : 1));
  const ari = f.children[2]!, aris = '+12025550177', own = '+12025550199';
  const otherHome = await factory('households', f.gymId);
  await db.forGym(f.gymId, tx => tx.update(members).set({ householdId: otherHome.id }).where(eq(members.id, first!.id)));
  await consentedPhone(f, first!.id, phone); await consentedPhone(f, ari.id, aris);
  const notice = { ...f.payload, memberIds: [first!.id, second!.id, ari.id], channels: ['sms'] as const };
  // The shared phone sorts first: its first member drops out while the run resolves; then the second phone's text fails.
  const prefix = `schedule-cancel-sms:${f.session.id}:`;
  let sends = 0, atSend: unknown;
  const failingSecond: Sms = { verifyAccount: () => f.sms.verifyAccount(), async sendSms(message) {
    if (++sends === 2) throw new DeliveryError('not_accepted', 'Provider unavailable');
    // Whom the text names is committed before the provider is called.
    atSend = (await states(f.gymId)).find(row => row.key === prefix + first!.id)?.commandResult;
    return f.sms.sendSms(message);
  } };
  f.resolver.resolve.mockImplementationOnce(async id => {
    await consentedPhone(f, first!.id, null);
    return { gymId: id, name: 'Cedar Gym', sms: failingSecond };
  });
  await expect(f.notice.run(notice, f.gymId)).rejects.toThrow();
  expect(f.sms.messages.map(message => message.to)).toEqual([phone]);
  expect(f.sms.messages[0]!.body).toContain(second!.firstName); expect(f.sms.messages[0]!.body).not.toContain(first!.firstName);
  expect(atSend).toEqual({ memberIds: [first!.id, second!.id], namedIds: [second!.id] });
  expect(await states(f.gymId)).toContainEqual({ key: prefix + first!.id, state: 'accepted',
    commandResult: { memberIds: [first!.id, second!.id], namedIds: [second!.id] } });

  await consentedPhone(f, first!.id, own);
  await f.notice.run(notice, f.gymId); await f.notice.run(notice, f.gymId);
  expect(f.sms.messages.map(message => message.to)).toEqual([phone, aris, own]);
  expect(f.sms.messages[2]!.body).toBe(selfText);
  expect(await states(f.gymId)).toContainEqual(expect.objectContaining({ key: `${prefix}${first!.id}.2`, state: 'accepted' }));
  // Erasing the member clears the regrouped key's phone digest as well.
  await db.forGym(f.gymId, tx => forgetErasedAddressDigests(tx, f.gymId, first!.id));
  const rows = await db.forGym(f.gymId, tx => tx.select().from(smsDeliveries));
  expect(rows.filter(row => row.key.startsWith(prefix + first!.id)).map(row => row.commandDigest)).toEqual([null, null]);
});

const byId = <T extends { id: string }>(...rows: T[]) => rows.sort((a, b) => (a.id < b.id ? -1 : 1));
const sentTo = (f: Awaited<ReturnType<typeof fixture>>) => f.sms.messages.map(message => message.to);
/** Moves members out of the shared household, each with their own notices consent at its billing phone. */
async function ownConsentAtPhone(f: Awaited<ReturnType<typeof fixture>>, ...memberIds: string[]) {
  const otherHome = await factory('households', f.gymId);
  for (const memberId of memberIds) {
    await db.forGym(f.gymId, tx => tx.update(members).set({ householdId: otherHome.id }).where(eq(members.id, memberId)));
    await consentedPhone(f, memberId, phone);
  }
}

it('texts a first member left out of a narrowed text at their own phone on the retry when its outcome is uncertain', async () => {
  const f = await fixture(), own = '+12025550199';
  const [first, second] = byId(f.children[0]!, f.children[1]!);
  await ownConsentAtPhone(f, first!.id);
  const notice = { ...f.payload, memberIds: [first!.id, second!.id], channels: ['sms'] as const };
  f.resolver.resolve.mockImplementationOnce(async id => {
    await consentedPhone(f, first!.id, null);
    return { gymId: id, name: 'Cedar Gym', sms: f.sms };
  });
  await f.notice.run(notice, f.gymId);
  expect(sentTo(f)).toEqual([phone]);
  const prefix = `schedule-cancel-sms:${f.session.id}:`;
  // As a failed outcome write leaves it.
  await db.forGym(f.gymId, tx => tx.update(smsDeliveries).set({ state: 'unknown' }).where(eq(smsDeliveries.key, prefix + first!.id)));
  await consentedPhone(f, first!.id, own);
  await f.notice.run(notice, f.gymId); await f.notice.run(notice, f.gymId);
  expect(sentTo(f)).toEqual([phone, own]);
  expect(f.sms.messages[1]!.body).toBe(selfText);
  expect(await states(f.gymId)).toContainEqual(expect.objectContaining({ key: `${prefix}${first!.id}.2`, state: 'accepted' }));
});

it('sends no second text to a phone after erasure clears the digest of a narrowed text that reached it', async () => {
  const f = await fixture(), own = '+12025550199';
  const [a, b, c] = byId(...f.children);
  // A and C have their own consent at the household's billing phone; B is reached through the household.
  await ownConsentAtPhone(f, a!.id, c!.id);
  const notice = { ...f.payload, memberIds: [a!.id, b!.id, c!.id], channels: ['sms'] as const };
  f.resolver.resolve.mockImplementationOnce(async id => {
    await consentedPhone(f, a!.id, null); await consentedPhone(f, c!.id, null);
    return { gymId: id, name: 'Cedar Gym', sms: f.sms };
  });
  await f.notice.run(notice, f.gymId);
  expect(sentTo(f)).toEqual([phone]);
  expect(f.sms.messages[0]!.body).toContain(b!.firstName);
  const prefix = `schedule-cancel-sms:${f.session.id}:`;
  expect(await states(f.gymId)).toEqual([{ key: prefix + a!.id, state: 'accepted',
    commandResult: { memberIds: [a!.id, b!.id, c!.id], namedIds: [b!.id] } }]);
  await db.forGym(f.gymId, tx => forgetErasedAddressDigests(tx, f.gymId, a!.id));
  await consentedPhone(f, b!.id, own); await consentedPhone(f, c!.id, phone);
  await f.notice.run(notice, f.gymId);
  expect(sentTo(f)).toEqual([phone]);
});

it('keeps a narrowed text\'s digest when a reserved member it left out is erased, so its first member is still texted at a new phone', async () => {
  const f = await fixture(), own = '+12025550199';
  const [a, b, c] = byId(...f.children);
  await ownConsentAtPhone(f, a!.id, c!.id);
  const notice = { ...f.payload, memberIds: [a!.id, b!.id, c!.id], channels: ['sms'] as const };
  f.resolver.resolve.mockImplementationOnce(async id => {
    await consentedPhone(f, a!.id, null); await consentedPhone(f, c!.id, null);
    return { gymId: id, name: 'Cedar Gym', sms: f.sms };
  });
  await f.notice.run(notice, f.gymId);
  expect(sentTo(f)).toEqual([phone]);
  const prefix = `schedule-cancel-sms:${f.session.id}:`;
  // Erasing C, who doesn't hold the row's key, leaves the digest of the row keyed by A, which named only B.
  await db.forGym(f.gymId, tx => forgetErasedAddressDigests(tx, f.gymId, c!.id));
  expect((await db.forGym(f.gymId, tx => tx.select().from(smsDeliveries)))[0]!.commandDigest).toBeTruthy();
  // A back at the shared phone (grouped with B under `<A>.2`) matches the digest; A at a new phone gets their own text.
  await consentedPhone(f, a!.id, phone);
  await f.notice.run(notice, f.gymId);
  await consentedPhone(f, a!.id, own);
  await f.notice.run(notice, f.gymId);
  expect(sentTo(f)).toEqual([phone, own]);
  expect(f.sms.messages[1]!.body).toBe(selfText);
  expect((await states(f.gymId)).map(row => row.key).sort()).toEqual([prefix + a!.id, `${prefix}${a!.id}.2`]);
});

it('keeps the reserved group on a text that names it, and only its key holder\'s erasure clears its own gym\'s digest', async () => {
  const f = await fixture(), otherGym = uuidv7();
  const [first, second] = byId(f.children[0]!, f.children[1]!);
  const notice = { ...f.payload, memberIds: [first!.id, second!.id], channels: ['sms'] as const };
  await f.notice.run(notice, f.gymId);
  expect(sentTo(f)).toEqual([phone]);
  const prefix = `schedule-cancel-sms:${f.session.id}:`;
  const deliveries = (gymId: string) => db.forGym(gymId, tx => tx.select().from(smsDeliveries));
  const [row] = await deliveries(f.gymId);
  expect(row).toMatchObject({ key: prefix + first!.id, state: 'accepted' });
  expect(row!.commandResult).toStrictEqual({ memberIds: [first!.id, second!.id] });
  expect(row!.commandDigest).toBeTruthy();
  await factory('gyms', otherGym);
  const now = f.clock.now();
  await db.forGym(otherGym, tx => tx.insert(smsDeliveries).values({ id: uuidv7(), gymId: otherGym, key: `schedule-cancel-sms:${uuidv7()}:${first!.id}`,
    state: 'accepted', attempts: 1, commandDigest: 'other-gym', commandResult: { memberIds: [first!.id, second!.id] }, createdAt: now, updatedAt: now }));
  // The second member doesn't hold the key: the digest stays.
  await db.forGym(f.gymId, tx => forgetErasedAddressDigests(tx, f.gymId, second!.id));
  expect((await deliveries(f.gymId))[0]!.commandDigest).toBe(row!.commandDigest);
  await db.forGym(f.gymId, tx => forgetErasedAddressDigests(tx, f.gymId, first!.id));
  const [after] = await deliveries(f.gymId);
  expect(after!.commandDigest).toBeNull();
  expect(after!.commandResult).toStrictEqual({ memberIds: [first!.id, second!.id] });
  expect((await deliveries(otherGym))[0]!.commandDigest).toBe('other-gym');
  await f.notice.run(notice, f.gymId);
  expect(sentTo(f)).toEqual([phone]);
});

it('retries a failed shared text after another member it reserved is erased', async () => {
  const f = await fixture();
  const [first, second] = byId(f.children[0]!, f.children[1]!);
  const notice = { ...f.payload, memberIds: [first!.id, second!.id], channels: ['sms'] as const };
  const failing: Sms = { verifyAccount: () => f.sms.verifyAccount(), async sendSms() { throw new DeliveryError('not_accepted', 'Provider unavailable'); } };
  f.resolver.resolve.mockImplementationOnce(async id => ({ gymId: id, name: 'Cedar Gym', sms: failing }));
  await expect(f.notice.run(notice, f.gymId)).rejects.toThrow();
  expect(sentTo(f)).toEqual([]);
  const prefix = `schedule-cancel-sms:${f.session.id}:`;
  expect(await states(f.gymId)).toEqual([expect.objectContaining({ key: prefix + first!.id, state: 'not_accepted' })]);
  await db.forGym(f.gymId, async tx => {
    await forgetErasedAddressDigests(tx, f.gymId, second!.id);
    await tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, second!.id));
  });
  await f.notice.run(notice, f.gymId);
  expect(sentTo(f)).toEqual([phone]);
  expect(f.sms.messages[0]!.body).toContain(first!.firstName); expect(f.sms.messages[0]!.body).not.toContain(second!.firstName);
  expect(await states(f.gymId)).toEqual([expect.objectContaining({ key: prefix + first!.id, state: 'accepted' })]);
});

it('texts a member a narrowed text never covered who shares a new phone with its left-out first member, after another reserved member\'s erasure', async () => {
  const f = await fixture(), shared = '+12025550177';
  const [a, b, c] = byId(...f.children);
  await ownConsentAtPhone(f, a!.id, c!.id);
  const notice = { ...f.payload, memberIds: [a!.id, b!.id, c!.id], channels: ['sms'] as const };
  f.resolver.resolve.mockImplementationOnce(async id => {
    await consentedPhone(f, a!.id, null); await consentedPhone(f, c!.id, null);
    return { gymId: id, name: 'Cedar Gym', sms: f.sms };
  });
  await f.notice.run(notice, f.gymId);
  expect(sentTo(f)).toEqual([phone]);
  await db.forGym(f.gymId, tx => forgetErasedAddressDigests(tx, f.gymId, c!.id));
  // D, from another household and created after A, sorts after A and shares A's new phone.
  const d = await factory('members', f.gymId, { householdId: (await factory('households', f.gymId)).id, firstName: 'Dee' });
  await consentedPhone(f, a!.id, shared); await consentedPhone(f, d.id, shared);
  await f.notice.run({ ...notice, memberIds: [a!.id, b!.id, c!.id, d.id] }, f.gymId);
  expect(sentTo(f)).toEqual([phone, shared]);
  expect(f.sms.messages[1]!.body).toContain(d.firstName);
  const prefix = `schedule-cancel-sms:${f.session.id}:`;
  expect(await states(f.gymId)).toContainEqual(expect.objectContaining({ key: `${prefix}${a!.id}.2`, state: 'accepted' }));
});

it('reads a narrowed text row in the earlier shape as naming only its stored members', async () => {
  const f = await fixture(), own = '+12025550199';
  const [first, second] = byId(f.children[0]!, f.children[1]!);
  await ownConsentAtPhone(f, first!.id); await consentedPhone(f, first!.id, own);
  const prefix = `schedule-cancel-sms:${f.session.id}:`, now = f.clock.now();
  await db.forGym(f.gymId, tx => tx.insert(smsDeliveries).values({ id: uuidv7(), gymId: f.gymId, key: prefix + first!.id, state: 'accepted',
    attempts: 1, commandDigest: prefix + digest(phone), commandResult: { memberIds: [second!.id] }, createdAt: now, updatedAt: now }));
  await f.notice.run({ ...f.payload, memberIds: [first!.id, second!.id], channels: ['sms'] }, f.gymId);
  expect(sentTo(f)).toEqual([own]);
  expect(f.sms.messages[0]!.body).toBe(selfText);
  expect(await states(f.gymId)).toContainEqual(expect.objectContaining({ key: `${prefix}${first!.id}.2`, state: 'accepted' }));
});

/** A cancelled class with `count` members, each at their own consented phone, sent by a run with counted dependencies. */
async function crowd(count: number, sms?: (f: Awaited<ReturnType<typeof fixture>>) => Sms) {
  const f = await fixture(), home = await factory('households', f.gymId);
  const people = [];
  for (let index = 0; index < count; index++) {
    const own = `+120255501${String(30 + index)}`;
    people.push(await factory('members', f.gymId, { householdId: home.id, firstName: `Member${index}`, phone: own, phoneE164: own,
      smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }));
  }
  const provider = sms?.(f) ?? f.sms;
  const resolver = { resolve: vi.fn(async (id: string) => ({ gymId: id, name: 'Cedar Gym', sms: provider })),
    status: async () => ({ source: 'gym' as const, unreadable: false }), configured: async () => true };
  const settings = createGymSettingsAccessor({ scope: db.forGym }), get = vi.spyOn(settings, 'get');
  const sender = createCancellationSms({ scope: db.forGym, clock: f.clock, settings, sms: { resolver, phoneDigest: digest } });
  const notice = { sessionId: f.session.id, memberIds: people.map(person => person.id) };
  return { ...f, people, resolver, get, run: () => sender.run(notice, f.gymId) };
}

it('resolves the provider and reads the gym settings once for a run texting 30 phones, each text with its own checks', async () => {
  const f = await crowd(30);
  await f.run();
  expect(f.sms.messages).toHaveLength(30);
  expect(new Set(f.sms.messages.map(message => message.to)).size).toBe(30);
  expect(f.resolver.resolve).toHaveBeenCalledTimes(1);
  expect(f.resolver.resolve).toHaveBeenCalledWith(f.gymId);
  // The last checks read the locked settings in their own transactions, not through the accessor.
  expect(f.get).toHaveBeenCalledTimes(1);
  expect(await usage(f.gymId)).toMatchObject([{ sent: 30 }]);
  const rows = await db.forGym(f.gymId, tx => tx.select({ state: smsDeliveries.state }).from(smsDeliveries));
  expect(rows).toHaveLength(30); expect(rows.every(row => row.state === 'accepted')).toBe(true);
});

it('stops a run\'s remaining texts through the last check when texts are turned off after the run starts', async () => {
  const log = vi.fn(), previousSink = setLogSink(log);
  try {
    const f = await crowd(5, g => ({
      verifyAccount: () => g.sms.verifyAccount(),
      async sendSms(message) {
        const result = await g.sms.sendSms(message);
        await db.forGym(g.gymId, tx => tx.update(gyms).set({ memberSmsEnabled: false }).where(eq(gyms.id, g.gymId)));
        return result;
      },
    }));
    await f.run();
    expect(f.sms.messages).toHaveLength(1);
    expect(f.resolver.resolve).toHaveBeenCalledTimes(1);
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.filter(([line]) => String(line).includes('"reason":"disabled"'))).toHaveLength(4);
    expect(await usage(f.gymId)).toMatchObject([{ sent: 1 }]);
  } finally { setLogSink(previousSink); }
});

it('fails every text of a run whose provider resolution rejects, resolving once and throwing the first failure', async () => {
  const f = await crowd(3), failure = new DeliveryError('not_accepted', 'SMS provider unreadable');
  f.resolver.resolve.mockImplementation(async () => { throw failure; });
  await expect(f.run()).rejects.toMatchObject({ acceptance: 'not_accepted' });
  expect(f.resolver.resolve).toHaveBeenCalledTimes(1);
  expect(f.sms.messages).toHaveLength(0);
  expect(await usage(f.gymId)).toEqual([]);
  const rows = await db.forGym(f.gymId, tx => tx.select({ state: smsDeliveries.state }).from(smsDeliveries));
  expect(rows).toHaveLength(3); expect(rows.every(row => row.state === 'not_accepted')).toBe(true);
});
