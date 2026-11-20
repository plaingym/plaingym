// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { announcementOptOuts, announcementSmsRecipients, members, smsDailyUsage, smsDeliveries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createMembersService } from '../members/members.js';
import { announcementSmsBody, AppError, errorResponse, smsSegments, type StaffRole } from '@plaingym/shared';
import { announcementDraftSchema } from '@plaingym/shared/contracts';
import type { RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createSmsPhoneDigest, DeliveryError, FakeSms } from '../../infra/sms/index.js';
import { smsInFlightMs } from '../../infra/sms/deliveries.js';
import { authorize } from '../staff/auth.permissions.js';
import { createAnnouncementJobs } from './jobs.js';
import { createAnnouncementRoutes } from './send.routes.js';
import { createAnnouncementsService } from './send.js';
import { announcementSmsJob, announcementSmsKey, nextAnnouncementSmsTime } from './send.sms.js';

const db = useTestDatabase(), factory = createFactories(db), phone = '+12025550123';
const digest = createSmsPhoneDigest('announcement-text-tests');
const draft = announcementDraftSchema.parse({ subject: 'Classes', body: 'Email body', sms: { body: 'Classes resume Monday.' } });
async function fixture(at = '2026-11-10T15:00:00Z', role: StaffRole = 'owner') {
  const gymId = uuidv7(), clock = new TestClock(at);
  await factory('gyms', gymId, { name: 'Cedar Gym', timezone: 'America/New_York', settings: { address: { country: 'US' } }, memberEmailsEnabled: true, memberSmsEnabled: true });
  const user = await factory('authUser', gymId), home = await factory('households', gymId);
  await factory('staffRoles', gymId, { userId: user.id, role });
  const email = new FakeEmail(), sms = new FakeSms(), jobs = new FakeJobs(clock);
  const resolver = { resolve: vi.fn(async (id: string) => ({ gymId: id, name: 'Cedar Gym', sms })),
    configured: async () => true, status: async () => ({ source: 'gym' as const, unreadable: false }) };
  const options = { scope: db.forGym, clock, jobs, smtp: { configured: async () => true }, mailer: async () => email,
    origin: async () => 'https://gym.example.test', senderEmail: async () => user.email, demoMode: false, sms: { resolver, phoneDigest: digest } };
  const service = createAnnouncementsService(options), actor = { gymId, userId: user.id };
  createServerRegistry({ jobs: createAnnouncementJobs(() => service) }).registerJobs(jobs, new Set());
  const member = (values: Partial<typeof members.$inferInsert> = {}) => factory('members', gymId, { householdId: home.id,
    phone, phoneE164: phone, status: 'active', email: uuidv7() + '@example.test', smsAnnouncementsConsentAt: clock.now(), smsAnnouncementsConsentSource: 'portal', ...values });
  const send = () => service.send(actor, { ...draft, confirm: true, sendGeneration: uuidv7() });
  const run = (id: string) => service.runSms({ announcementId: id }, gymId);
  function app() {
    const app = new OpenAPIHono<RequestEnvironment>();
    app.use('*', async (c, next) => { c.set('context', { requestId: 'texts', gym: { gymId, timezone: 'America/New_York', enabledModules: new Set() },
      principal: { kind: 'staff', gymId, userId: user.id, roles: [role] }, clock }); await next(); });
    app.onError((error, c) => c.json(errorResponse(error, 'texts'), error instanceof AppError ? error.status : 500));
    createServerRegistry({ routes: createAnnouncementRoutes(() => service) }).mount(app, authorize, new Set());
    return app;
  }
  return { gymId, clock, sms, email, jobs, resolver, options, actor, service, member, send, run, app };
}
it.each([
  ['2026-03-08T03:00:00Z', '2026-03-08T12:00:00.000Z'],
  ['2026-11-01T02:00:00Z', '2026-11-01T13:00:00.000Z'],
  ['2026-11-11T03:00:00Z', '2026-11-11T13:00:00.000Z'],
])('a 22:00 confirmation waits until 08:00 across clock changes: %s', async (at, expected) => {
  const f = await fixture(at); await f.member();
  const row = await f.send();
  expect(row.smsScheduledFor).toBe(expected);
  await f.service.run({ announcementId: row.id }, f.gymId);
  expect(f.email.messages).toHaveLength(1); expect(f.sms.messages).toHaveLength(0);
  expect(f.jobs.jobs.find(job => job.name === announcementSmsJob)?.runAt.toISOString()).toBe(expected);
  expect(await f.jobs.runNext()).toBe(true); // Email is due immediately.
  expect(await f.jobs.runNext()).toBe(false);
  f.clock.set(new Date(expected)); expect(await f.jobs.runNext()).toBe(true);
  expect(f.sms.messages).toEqual([{ to: phone, body: announcementSmsBody('Cedar Gym', draft.sms!.body) }]);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ smsSent: 1, smsScheduledFor: null, smsCompletedAt: expected });
});
it('uses exact open and closing boundaries', () => {
  expect(nextAnnouncementSmsTime(new Date('2026-11-10T13:00:00Z'), 'America/New_York')).toBeNull();
  expect(nextAnnouncementSmsTime(new Date('2026-11-11T02:00:00Z'), 'America/New_York')?.toISOString()).toBe('2026-11-11T13:00:00.000Z');
});
it('queues email first so an immediately due text batch cannot hold it up', async () => {
  const f = await fixture(); await f.member(); await f.send();
  expect(f.jobs.jobs.map(job => job.name)).toEqual(['announcements.send', announcementSmsJob]);
  expect(await f.jobs.runNext()).toBe(true); expect(f.email.messages).toHaveLength(1); expect(f.sms.messages).toHaveLength(0);
  expect(await f.jobs.runNext()).toBe(true); expect(f.sms.messages).toHaveLength(1);
});
it('pauses a batch crossing 21:00 and resumes its remaining phone at 08:00', async () => {
  const f = await fixture('2026-11-11T01:59:59Z'); await f.member(); await f.member({ phone: '+12025550124', phoneE164: '+12025550124' });
  const row = await f.send(), send = f.sms.sendSms.bind(f.sms);
  vi.spyOn(f.sms, 'sendSms').mockImplementation(async message => { const result = await send(message); f.clock.set(new Date('2026-11-11T02:00:00Z')); return result; });
  await f.run(row.id); expect(f.sms.messages).toHaveLength(1);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ smsSent: 1, smsScheduledFor: '2026-11-11T13:00:00.000Z' });
  f.clock.set(new Date('2026-11-11T13:00:00Z')); await f.run(row.id); await f.run(row.id);
  expect(f.sms.messages).toHaveLength(2); expect(new Set(f.sms.messages.map(message => message.to)).size).toBe(2);
});
it('rechecks quiet hours after slow provider resolution without deciding the recipient', async () => {
  const f = await fixture('2026-11-11T01:59:59Z'); await f.member(); const row = await f.send();
  f.resolver.resolve.mockImplementation(async id => { f.clock.set(new Date('2026-11-11T02:00:00Z')); return { gymId: id, name: 'Cedar Gym', sms: f.sms }; });
  await f.run(row.id); expect(f.sms.messages).toHaveLength(0);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ smsFailed: 0, smsScheduledFor: '2026-11-11T13:00:00.000Z' });
});
it('counts only consenting phones, ignores email preferences, deduplicates and rechecks consent', async () => {
  const f = await fixture(); const first = await f.member({ emailOptOut: true }); await f.member({ email: null });
  await db.forGym(f.gymId, tx => tx.insert(announcementOptOuts).values({ gymId: f.gymId, memberId: first.id }));
  await f.member({ phone: '+12025550124', phoneE164: '+12025550124', smsAnnouncementsConsentAt: null, smsAnnouncementsConsentSource: null, smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' });
  await f.member({ phone: 'invalid' });
  const b = await fixture(); await b.member();
  const preview = await f.service.preview(f.gymId, draft);
  expect(preview.smsRecipientCount).toBe(1); expect(preview.smsSegments).toBe(smsSegments(announcementSmsBody('Cedar Gym', draft.sms!.body)).segments);
  const row = await f.send(); await Promise.allSettled([f.run(row.id), f.run(row.id)]); await f.run(row.id);
  expect(f.sms.messages).toHaveLength(1); expect(b.sms.messages).toHaveLength(0);
  const later = await f.send(); await db.forGym(f.gymId, tx => tx.update(members).set({ smsAnnouncementsConsentAt: null, smsAnnouncementsConsentSource: null }));
  await f.run(later.id); expect(f.sms.messages).toHaveLength(1);
  expect(await f.service.get(f.gymId, later.id)).toMatchObject({ smsSkipped: 1 });
});
it.each(['accepted', 'sending', 'unknown'] as const)('settles a crashed %s reservation without texting again', async state => {
  const f = await fixture(); const person = await f.member(), row = await f.send();
  await factory('smsDeliveries', f.gymId, { key: announcementSmsKey(row.id, person.id), state,
    commandDigest: `announcement-sms:${row.id}:${digest(phone)}`, updatedAt: new Date(f.clock.now().getTime() - smsInFlightMs - 1) });
  await f.run(row.id); await f.run(row.id); expect(f.sms.messages).toHaveLength(0);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject(state === 'accepted' ? { smsSent: 1 } : { smsFailed: 1 });
});
it('never resends an unknown provider outcome', async () => {
  const f = await fixture(); await f.member(); const row = await f.send();
  f.sms.respondNext(new DeliveryError('unknown', 'Lost response')); await f.run(row.id); await f.run(row.id);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ smsFailed: 1 }); expect(f.sms.messages).toHaveLength(0);
});
it('includes the prefix and STOP line in the 480-character limit and generation replay', async () => {
  const f = await fixture(); const overhead = announcementSmsBody('Cedar Gym', '').length;
  const exact = { ...draft, sms: { body: 'x'.repeat(480 - overhead) } };
  await expect(f.service.preview(f.gymId, exact)).resolves.toMatchObject({ smsSegments: 4 });
  await expect(f.service.preview(f.gymId, { ...exact, sms: { body: exact.sms.body + 'x' } })).rejects.toMatchObject({ code: 'invalid_request' });
  const input = { ...exact, confirm: true as const, sendGeneration: uuidv7() }, row = await f.service.send(f.actor, input);
  expect((await f.service.send(f.actor, input)).id).toBe(row.id);
  await expect(f.service.send(f.actor, { ...input, sms: { body: 'Changed' } })).rejects.toMatchObject({ code: 'conflict' });
});
it('test texts use only the entered phone, bypass member consent and consume the cap', async () => {
  const f = await fixture('2026-11-11T03:00:00Z'); await f.member();
  await f.service.testSms(f.actor, { ...draft, sms: draft.sms!, testTo: '+12025550124' });
  expect(f.sms.messages).toEqual([{ to: '+12025550124', body: announcementSmsBody('Cedar Gym', draft.sms!.body) }]);
  const usage = await db.forGym(f.gymId, tx => tx.select().from(smsDailyUsage)); expect(usage[0]?.sent).toBe(1);
});
it.each(['owner', 'admin', 'coach', 'front_desk'] as const)('enforces announcements.send on text test and send for %s', async role => {
  const f = await fixture(undefined, role);
  for (const [path, body] of [['test-sms', { ...draft, testTo: phone }], ['send', { ...draft, confirm: true, sendGeneration: uuidv7() }]] as const) {
    const response = await f.app().request('/api/announcements/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(['owner', 'admin'].includes(role) ? 200 : 403);
  }
});
it('isolates announcement texts and program selection across gyms', async () => {
  const a = await fixture(), b = await fixture(); await a.member(); const row = await a.send();
  await expect(b.run(row.id)).rejects.toMatchObject({ code: 'not_found' });
  const foreign = await factory('programs', b.gymId);
  await expect(a.service.preview(a.gymId, { ...draft, audience: { ...draft.audience, programIds: [foreign.id] } })).rejects.toMatchObject({ code: 'not_found' });
  const response = await a.app().request('/api/announcements/test-sms', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...draft, testTo: phone, audience: { ...draft.audience, programIds: [foreign.id] } }) });
  expect(response.status).toBe(404); expect(a.sms.messages).toHaveLength(0);
});
function memberRemoval(f: Awaited<ReturnType<typeof fixture>>) {
  const service = createMembersService({ scope: db.forGym, clock: f.clock });
  const context = { gymId: f.gymId, actor: { kind: 'user' as const, userId: f.actor.userId } };
  const cleanup = { jobs: f.jobs, timezone: 'America/New_York' };
  return {
    erase: (id: string) => service.eraseMember(context, id, { revision: 1 }, cleanup),
    remove: (id: string) => service.deleteMember(context, id, 1, cleanup),
    recipients: () => db.forGym(f.gymId, tx => tx.select().from(announcementSmsRecipients)),
    deliveries: () => db.forGym(f.gymId, tx => tx.select().from(smsDeliveries)),
  };
}

it('erases the first member of a pending shared text and sends it once to the remaining member', async () => {
  const f = await fixture(), first = await f.member(), sibling = await f.member(), row = await f.send();
  const removal = memberRemoval(f), [before] = await removal.recipients();
  expect(before).toMatchObject({ memberId: first.id, memberIds: [first.id, sibling.id], phoneDigest: digest(phone) });
  await removal.erase(first.id);
  expect(await removal.recipients()).toEqual([expect.objectContaining({ id: before!.id, memberId: sibling.id,
    memberIds: [sibling.id], phoneDigest: digest(phone), state: 'pending' })]);
  await f.run(row.id); await f.run(row.id);
  expect(f.sms.messages).toEqual([{ to: phone, body: announcementSmsBody('Cedar Gym', draft.sms!.body) }]);
});

it('clears transport digests during erasure and keeps the snapshot digest until the last member leaves', async () => {
  const f = await fixture(), first = await f.member(), sibling = await f.member(), row = await f.send();
  const removal = memberRemoval(f);
  await f.run(row.id);
  await removal.erase(sibling.id);
  expect(await removal.deliveries()).toEqual([expect.objectContaining({ commandDigest: null, state: 'accepted' })]);
  expect(await removal.recipients()).toEqual([expect.objectContaining({ memberIds: [first.id], phoneDigest: digest(phone) })]);
  await removal.erase(first.id);
  expect(await removal.recipients()).toEqual([expect.objectContaining({ phoneDigest: null, state: 'sent' })]);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ smsSent: 1 });
});

it.each([false, true])('keeps the shared row and removes a deleted member (first=%s)', async deleteFirst => {
  const f = await fixture(), first = await f.member(), second = await f.member(), row = await f.send();
  const removal = memberRemoval(f), [before] = await removal.recipients();
  const remaining = deleteFirst ? second : first;
  await removal.remove(deleteFirst ? first.id : second.id);
  expect(await removal.recipients()).toEqual([expect.objectContaining({ id: before!.id, memberId: remaining.id,
    memberIds: [remaining.id], phoneDigest: digest(phone) })]);
  await f.run(row.id);
  expect(f.sms.messages).toHaveLength(1);
});

it.each(['accepted', 'not_accepted'] as const)('preserves a legacy %s reservation after deleting its anchor', async state => {
  const f = await fixture(), first = await f.member(), second = await f.member(), row = await f.send();
  const removal = memberRemoval(f), [before] = await removal.recipients();
  const delivery = await factory('smsDeliveries', f.gymId, { key: announcementSmsKey(row.id, first.id),
    commandDigest: `announcement-sms:${row.id}:${digest(phone)}`, state });
  await removal.remove(first.id);
  expect(await removal.recipients()).toEqual([expect.objectContaining({ memberId: second.id, memberIds: [second.id] })]);
  await f.run(row.id); await f.run(row.id);
  expect(f.sms.messages).toHaveLength(state === 'accepted' ? 0 : 1);
  expect(await removal.deliveries()).toEqual([expect.objectContaining({ id: delivery.id, key: announcementSmsKey(row.id, before!.id),
    commandDigest: null, state: 'accepted' })]);
});
it('keeps unbilled member deletion working after a text recipient was snapshotted', async () => {
  const f = await fixture(), person = await f.member(); await f.send();
  const removal = memberRemoval(f);
  await removal.remove(person.id);
  expect(await removal.recipients()).toEqual([]);
});
