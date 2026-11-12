// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { OpenAPIHono } from '@hono/zod-openapi';
import { announcementOptOuts, announcementRecipients, auditEvents, emailOutbox, memberRanks, members, signedLinks, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, errorResponse, type StaffRole } from '@plaingym/shared';
import { announcementDraftSchema, announcementsContracts } from '@plaingym/shared/contracts';
import { isInTransaction } from '@plaingym/shared/transaction';
import { createApp } from '../../app.js';
import { TestClock } from '../../core/clock.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { areaContributions } from '../../core/registry-areas.js';
import { createServerRegistry } from '../../core/registry.js';
import { DeliveryError, FakeEmail } from '../../infra/email/index.js';
import { OutboxEmail } from '../../infra/email/outbox.js';
import { createEmailDeliveries, commandDigest, emailInFlightMs } from '../../infra/email/deliveries.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { authorize } from '../staff/auth.permissions.js';
import { createGoLiveService } from '../settings/go-live.js';
import { createAnnouncementJobs } from './jobs.js';
import { createAnnouncementRoutes } from './send.routes.js';
import { announcementDeliveryKey } from './send.delivery.js';
import { announcementSendJob, configureAnnouncements, createAnnouncementsService } from './send.js';
import { issueUnsubscribeLink } from './unsubscribe.js';
import * as template from '../../emails/announcements/send.js';

const db = useTestDatabase(), factory = createFactories(db), origin = 'https://gym.example.test';
const draft = announcementDraftSchema.parse({ subject: 'Closed Monday', body: 'See you Tuesday.\n\nhttps://example.test/classes' });
it('isolates generations from primary keys and from other gyms', async () => {
  const a = await fixture(), b = await fixture(), first = await a.send();
  const second = await b.service.send(b.actor, { ...b.input(), sendGeneration: first.id });
  expect(second.id).not.toBe(first.id); expect(second.id[14]).toBe('7');
  expect(await b.service.send(b.actor, { ...b.input(), sendGeneration: first.id })).toEqual(second);
  const shared = a.input();
  const [one, two] = await Promise.all([a.service.send(a.actor, shared), b.service.send(b.actor, shared)]);
  expect(one.id).not.toBe(two.id);
});
it('replays a queued generation even after the switch, SMTP and origin become unavailable', async () => {
  const f = await fixture(), input = f.input(), queued = await f.service.send(f.actor, input);
  await f.emailSwitch(false); f.options.smtp.configured.mockResolvedValue(false);
  const service = createAnnouncementsService({ ...f.options, origin: async () => { throw new Error('No hostname'); } });
  expect(await service.send(f.actor, input)).toEqual(queued);
  expect(f.jobs.jobs).toHaveLength(1);
  await expect(service.send(f.actor, { ...input, body: 'Different' })).rejects.toMatchObject({ code: 'conflict' });
});
it.each(['http://localhost:3000', '', 'https://gym.example/path', 'https://user:pass@gym.example'])('refuses preview and new sends without a canonical HTTPS origin: %s', async origin => {
  const f = await fixture(), service = createAnnouncementsService({ ...f.options, origin: async () => origin });
  for (const action of [() => service.preview(f.gymId, draft), () => service.send(f.actor, f.input())])
    await expect(action()).rejects.toMatchObject({ code: 'conflict', details: { reason: ['no_origin'] } });
  expect(f.jobs.jobs).toHaveLength(0);
});
async function fixture(role: StaffRole = 'owner') {
  const gymId = uuidv7(), clock = new TestClock('2026-11-09T12:00:00Z');
  await factory('gyms', gymId, { memberEmailsEnabled: true });
  const household = await factory('households', gymId);
  const user = await factory('authUser', gymId);
  await factory('staffRoles', gymId, { userId: user.id, role });
  const email = new FakeEmail(), jobs = new FakeJobs(clock);
  const options = { scope: db.forGym, clock, jobs, smtp: { configured: vi.fn(async () => true) }, demoMode: false,
    origin: async () => origin, mailer: vi.fn(async () => { expect(isInTransaction()).toBe(false); return email; }),
    senderEmail: vi.fn(async () => user.email) };
  const service = createAnnouncementsService(options), actor = { gymId, userId: user.id };
  const principal: Principal = { kind: 'staff', gymId, userId: user.id, roles: [role] };
  const goLive = createGoLiveService({ scope: db.forGym, clock, smtpConfigured: async () => true });
  const emailSwitch = async (enabled: boolean) => goLive.update({ gymId, actor: { kind: 'user', userId: user.id } },
    { revision: (await goLive.checklist(gymId)).revision, memberEmailsEnabled: enabled });
  const member = (values: Partial<typeof members.$inferInsert> = {}) => factory('members', gymId,
    { householdId: household.id, status: 'active', email: uuidv7() + '@example.test', ...values });
  const input = () => ({ ...draft, confirm: true as const, sendGeneration: uuidv7() });
  const send = () => service.send(actor, input());
  const run = (id: string) => service.run({ announcementId: id }, gymId);
  function app(resolvedGym = gymId) {
    const app = new OpenAPIHono<RequestEnvironment>();
    app.use('*', async (c, next) => { c.set('context', { requestId: 'announcements', gym: { gymId: resolvedGym, timezone: 'UTC', enabledModules: new Set() }, principal, clock }); await next(); });
    app.onError((error, c) => c.json(errorResponse(error, 'announcements'), error instanceof AppError ? error.status : 500));
    createServerRegistry({ routes: createAnnouncementRoutes(() => service) }).mount(app, authorize, new Set());
    return app;
  }
  const recipients = () => db.forGym(gymId, tx => tx.select().from(announcementRecipients));
  return { gymId, clock, household, user, actor, principal, options, service, email, jobs, member, input, send, run, app, recipients, emailSwitch };
}
it('selects one normalized address, excludes flags, anonymized and ineligible members and other gyms', async () => {
  const f = await fixture();
  await f.member({ email: ' SAME@example.test ' }); await f.member({ email: 'same@example.test', status: 'trial' });
  await f.member({ status: 'frozen' });
  for (const status of ['cancelled', 'prospect', 'visitor']) await f.member({ status });
  await f.member({ email: null }); await f.member({ anonymizedAt: f.clock.now() });
  await f.member({ emailOptOut: true }); await f.member({ emailDeliverable: false });
  const optedOut = await f.member();
  await db.forGym(f.gymId, tx => tx.insert(announcementOptOuts).values({ gymId: f.gymId, memberId: optedOut.id }));
  const other = await fixture(); await other.member();
  expect(await f.service.preview(f.gymId, draft)).toEqual({ recipientCount: 2 });
  const created = await f.send(); await f.run(created.id);
  expect(f.email.messages).toHaveLength(2);
  expect(new Set(f.email.messages.map(message => message.to)).size).toBe(2);
  expect(await other.service.list(other.gymId)).toMatchObject({ data: [] });
});
it.each(['emailOptOut', 'emailDeliverable', 'announcement'] as const)('blocks an entire address when a member outside the audience has %s suppression', async kind => {
  const f = await fixture();
  await f.member({ email: 'SHARED@example.test' });
  const blocked = await f.member({ email: ' shared@example.test ', status: 'cancelled', ...(kind === 'emailOptOut' ? { emailOptOut: true } : kind === 'emailDeliverable' ? { emailDeliverable: false } : {}) });
  if (kind === 'announcement') await db.forGym(f.gymId, tx => tx.insert(announcementOptOuts).values({ gymId: f.gymId, memberId: blocked.id }));
  expect(await f.service.preview(f.gymId, draft)).toEqual({ recipientCount: 0 });
});
it('honors status and program filters and rejects a foreign program', async () => {
  const f = await fixture();
  const active = await f.member(), trial = await f.member({ status: 'trial' }); await f.member();
  const system = await factory('rankSystems', f.gymId), rank = await factory('ranks', f.gymId, { rankSystemId: system.id });
  const program = await factory('programs', f.gymId, { rankSystemId: system.id });
  for (const member of [active, trial]) await factory('memberRanks', f.gymId, { memberId: member.id, programId: program.id, rankId: rank.id, rankSystemId: system.id });
  expect(await f.service.preview(f.gymId, { ...draft, audience: { statuses: ['active'], programIds: [program.id] } })).toEqual({ recipientCount: 1 });
  expect(await f.service.preview(f.gymId, { ...draft, audience: { statuses: ['trial'], programIds: [] } })).toEqual({ recipientCount: 1 });
  const foreign = await fixture(), foreignProgram = await factory('programs', foreign.gymId);
  await expect(f.service.preview(f.gymId, { ...draft, audience: { ...draft.audience, programIds: [foreignProgram.id] } })).rejects.toMatchObject({ code: 'not_found' });
});
it('queues atomically, replays a double click and refuses reuse for another message', async () => {
  const f = await fixture(); await f.member();
  const input = f.input();
  const results = await Promise.all([f.service.send(f.actor, input), f.service.send(f.actor, input)]);
  expect(results[0]!.id).toBe(results[1]!.id); expect(f.jobs.jobs).toHaveLength(1);
  expect(await f.recipients()).toHaveLength(1);
  await expect(f.service.send(f.actor, { ...input, body: 'Different' })).rejects.toMatchObject({ code: 'conflict' });
  vi.spyOn(f.jobs, 'enqueue').mockRejectedValueOnce(new Error('Queue failed'));
  await expect(f.send()).rejects.toThrow('Queue failed');
  expect((await f.service.list(f.gymId)).data).toHaveLength(1);
  const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'announcement.queued')));
  expect(audits).toHaveLength(1);
});
it.each(['disabled', 'no_smtp'] as const)('refuses preview and confirmation with the stable %s reason', async reason => {
  const f = await fixture();
  if (reason === 'disabled') await f.emailSwitch(false); else f.options.smtp.configured.mockResolvedValue(false);
  for (const action of [() => f.service.preview(f.gymId, draft), f.send]) await expect(action()).rejects.toMatchObject({ code: 'conflict', details: { reason: [reason] } });
  expect(f.jobs.jobs).toHaveLength(0);
});
it('skips opt-outs after confirmation and rechecks after mail preparation', async () => {
  const f = await fixture(), first = await f.member(), second = await f.member();
  const row = await f.send();
  await db.forGym(f.gymId, tx => tx.insert(announcementOptOuts).values({ gymId: f.gymId, memberId: first.id }));
  f.options.mailer.mockImplementation(async () => {
    await db.forGym(f.gymId, tx => tx.insert(announcementOptOuts).values({ gymId: f.gymId, memberId: second.id }).onConflictDoNothing());
    return f.email;
  });
  await f.run(row.id); expect(f.email.messages).toHaveLength(0);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ status: 'sent', skipped: 2 });
});
it.each(['\t', '\u00a0'])('keeps a legacy %j-padded address in its suppression group during delivery', async whitespace => {
  for (const kind of ['emailOptOut', 'emailDeliverable', 'announcement'] as const) {
    const f = await fixture(); await f.member({ email: 'shared@example.test' });
    const row = await f.send();
    const blocked = await f.member({ email: whitespace + 'SHARED@example.test' + whitespace, status: 'cancelled',
      ...(kind === 'emailOptOut' ? { emailOptOut: true } : kind === 'emailDeliverable' ? { emailDeliverable: false } : {}) });
    if (kind === 'announcement') await factory('announcementOptOuts', f.gymId, { memberId: blocked.id });
    await f.run(row.id);
    expect(f.email.messages).toHaveLength(0);
    expect(await f.service.get(f.gymId, row.id)).toMatchObject({ skipped: 1, sent: 0, status: 'sent' });
  }
});
it.each(['announcement', 'global', 'program', 'status', 'erasure'] as const)('rechecks %s changes made while rendering, before reserving or sending', async change => {
  const f = await fixture(), member = await f.member({ email: 'shared@example.test' });
  const sibling = await f.member({ email: ' SHARED@example.test ', status: 'cancelled' });
  const system = await factory('rankSystems', f.gymId), rank = await factory('ranks', f.gymId, { rankSystemId: system.id });
  const program = await factory('programs', f.gymId, { rankSystemId: system.id });
  const promotion = await factory('memberRanks', f.gymId, { memberId: member.id, programId: program.id, rankId: rank.id, rankSystemId: system.id });
  const row = await f.service.send(f.actor, { ...f.input(), audience: { statuses: ['active'], programIds: [program.id] } });
  const render = template.renderAnnouncement;
  const spy = vi.spyOn(template, 'renderAnnouncement').mockImplementationOnce(async input => {
    const result = await render(input);
    await db.forGym(f.gymId, async tx => {
      if (change === 'announcement') await tx.insert(announcementOptOuts).values({ gymId: f.gymId, memberId: sibling.id });
      else if (change === 'global') await tx.update(members).set({ emailOptOut: true }).where(eq(members.id, sibling.id));
      else if (change === 'program') await tx.delete(memberRanks).where(eq(memberRanks.id, promotion.id));
      else await tx.update(members).set(change === 'status' ? { status: 'cancelled' } : { anonymizedAt: f.clock.now() }).where(eq(members.id, member.id));
    });
    return result;
  });
  try { await f.run(row.id); } finally { spy.mockRestore(); }
  expect(f.email.messages).toHaveLength(0);
  expect(await db.forGym(f.gymId, tx => tx.select().from(signedLinks))).toHaveLength(0);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ skipped: 1, sent: 0, status: 'sent' });
});
it('reserves nothing when mail preparation fails, so the job retry still sends', async () => {
  const f = await fixture(); await f.member(); await f.member();
  const row = await f.send();
  f.options.mailer.mockRejectedValueOnce(new Error('SMTP settings unavailable'));
  await expect(f.run(row.id)).rejects.toThrow('SMTP settings unavailable');
  expect((await f.recipients()).map(recipient => recipient.state)).toEqual(['pending', 'pending']);
  expect(await db.forGym(f.gymId, tx => tx.select().from(signedLinks))).toHaveLength(0);
  await f.run(row.id);
  expect(f.email.messages).toHaveLength(2);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ status: 'sent', sent: 2, failed: 0 });
  expect(f.options.mailer).toHaveBeenCalledTimes(2);
});
it('skips the remaining recipients when the switch turns off mid-batch', async () => {
  const f = await fixture(); await f.member(); await f.member(); await f.member();
  const row = await f.send(), send = f.email.sendEmail.bind(f.email);
  vi.spyOn(f.email, 'sendEmail').mockImplementation(async message => { const result = await send(message); await f.emailSwitch(false); return result; });
  await f.run(row.id);
  expect(f.email.messages).toHaveLength(1);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ sent: 1, skipped: 2, failed: 0, status: 'sent' });
  expect((await f.recipients()).filter(recipient => recipient.state === 'skipped').map(recipient => recipient.reason)).toEqual(['disabled', 'disabled']);
});
it('gives each actual recipient their own signed unsubscribe link and header', async () => {
  const f = await fixture(), people = [await f.member(), await f.member()];
  const row = await f.send(); await f.run(row.id); await f.run(row.id);
  expect(f.email.messages).toHaveLength(2);
  const links = await db.forGym(f.gymId, tx => tx.select().from(signedLinks));
  for (const message of f.email.messages) {
    const url = message.listUnsubscribe!;
    expect(message.text).toContain(url); expect(message.html).toContain(url);
    const hash = createHash('sha256').update(new URL(url).pathname.slice(3)).digest('hex');
    expect(links.find(link => link.tokenHash === hash)).toMatchObject({ purpose: 'unsubscribe', memberId: people.find(person => person.email === message.to)!.id });
  }
});
it.each(['reserved', 'accepted', 'unknown'] as const)('resumes a batch after a crash at %s without another send', async phase => {
  const f = await fixture(), person = await f.member();
  const row = await f.send(), recipient = (await f.recipients())[0]!;
  const deliveries = createEmailDeliveries({ scope: db.forGym, clock: f.clock });
  const reservation = await db.forGym(f.gymId, async tx => {
    const reserved = await deliveries.reserve(tx, f.gymId, announcementDeliveryKey(row.id, recipient.id), commandDigest([row.id, person.email]));
    await issueUnsubscribeLink(tx, f.gymId, person.id, f.clock.now()); return reserved;
  });
  if (phase !== 'reserved') {
    if (phase === 'unknown') f.email.respondNext(new DeliveryError('unknown', 'Lost reply'));
    await deliveries.attempt(reservation, f.email, { to: person.email!, subject: 'Original', text: 'Original', html: '<p>Original</p>' }).catch(() => undefined);
  } else {
    await expect(f.run(row.id)).rejects.toMatchObject({ code: 'conflict' });
    f.clock.advance(emailInFlightMs + 1);
  }
  const sends = f.email.messages.length;
  await f.run(row.id); await f.run(row.id);
  expect(f.email.messages).toHaveLength(sends);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ status: 'sent', sent: phase === 'accepted' ? 1 : 0, failed: phase === 'accepted' ? 0 : 1 });
});
it.each(['not_accepted', 'unknown'] as const)('records %s as failed and never retries the address', async acceptance => {
  const f = await fixture(); await f.member(); const row = await f.send();
  const transport = vi.spyOn(f.email, 'sendEmail'); f.email.respondNext(new DeliveryError(acceptance, 'Safe error'));
  await f.run(row.id); await f.run(row.id);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ failed: 1, sent: 0, skipped: 0 });
});
it('recovers an interrupted real worker immediately after its reservation commit', async () => {
  const f = await fixture(); await f.member(); const row = await f.send();
  let interrupt = true;
  const scope: typeof db.forGym = async (gymId, fn) => {
    const result = await db.forGym(gymId, fn);
    if (interrupt && result && typeof result === 'object' && 'reserved' in result) { interrupt = false; throw new Error('Worker stopped'); }
    return result;
  };
  const worker = createAnnouncementsService({ ...f.options, scope });
  await expect(worker.run({ announcementId: row.id }, f.gymId)).rejects.toThrow('Worker stopped');
  expect(f.email.messages).toHaveLength(0);
  expect(await db.forGym(f.gymId, tx => tx.select().from(signedLinks))).toHaveLength(1);
  f.clock.advance(emailInFlightMs + 1); await f.run(row.id);
  expect(f.email.messages).toHaveLength(0);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ failed: 1, status: 'sent' });
});
it('recovers a crash after SMTP accepted but before the recipient outcome commits', async () => {
  const f = await fixture(); await f.member(); const row = await f.send();
  let interrupt = true;
  const scope: typeof db.forGym = (gymId, fn) => db.forGym(gymId, tx => fn(new Proxy(tx, { get(target, property) {
    if (property === 'update') return (...args: Parameters<typeof tx.update>) => {
      if (interrupt && f.email.messages.length && args[0] === announcementRecipients) { interrupt = false; throw new Error('Outcome write interrupted'); }
      return target.update(...args);
    };
    const value = Reflect.get(target, property) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } })));
  const worker = createAnnouncementsService({ ...f.options, scope });
  await expect(worker.run({ announcementId: row.id }, f.gymId)).rejects.toThrow('Outcome write interrupted');
  expect(f.email.messages).toHaveLength(1);
  await f.run(row.id);
  expect(f.email.messages).toHaveLength(1);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ sent: 1, failed: 0, status: 'sent' });
});
it('completes an empty audience and refuses demo sending without its outbox', async () => {
  const f = await fixture(), row = await f.send(); await f.run(row.id);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ status: 'sent', recipientCount: 0, sent: 0 });
  const demo = createAnnouncementsService({ ...f.options, demoMode: true });
  await expect(demo.send(f.actor, f.input())).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.options.mailer).not.toHaveBeenCalled();
});
it('deduplicates addresses that converge, including after the first member changes away', async () => {
  const f = await fixture(), first = await f.member({ email: 'first@example.test' }), second = await f.member({ email: 'second@example.test' });
  const row = await f.send(), send = f.email.sendEmail.bind(f.email);
  vi.spyOn(f.email, 'sendEmail').mockImplementation(async message => {
    const result = await send(message);
    const sent = message.to === first.email ? first : second, pending = sent.id === first.id ? second : first;
    await db.forGym(f.gymId, async tx => {
      await tx.update(members).set({ email: 'moved@example.test' }).where(eq(members.id, sent.id));
      await tx.update(members).set({ email: message.to.toUpperCase() }).where(eq(members.id, pending.id));
    }); return result;
  });
  await f.run(row.id);
  expect(f.email.messages).toHaveLength(1);
  expect((await f.recipients()).find(recipient => recipient.state === 'skipped')).toMatchObject({ reason: 'duplicate_address' });
});
it('sends tests only to the signed-in sender, with an inert footer even when member email is disabled', async () => {
  const f = await fixture(); await f.emailSwitch(false);
  await f.service.test(f.actor, draft);
  expect(f.options.senderEmail).toHaveBeenCalledWith(f.gymId, f.user.id);
  expect(f.email.messages).toHaveLength(1);
  expect(f.email.messages[0]).toMatchObject({ to: f.user.email, subject: '[Test] Closed Monday' });
  expect(f.email.messages[0]!.listUnsubscribe).toBeUndefined();
  expect(f.email.messages[0]!.text).toContain('inactive in this test');
  expect(await f.recipients()).toEqual([]);
});
it('serializes overlapping workers and resumes without duplicate messages', async () => {
  const f = await fixture(); await f.member(); await f.member(); const row = await f.send();
  const outcomes = await Promise.allSettled([f.run(row.id), f.run(row.id)]);
  for (const outcome of outcomes) if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ code: 'conflict' });
  await f.run(row.id);
  expect(f.email.messages).toHaveLength(2);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ sent: 2, failed: 0 });
});
it('inserts and decides multiple chunks and paginates the history', async () => {
  const f = await fixture();
  await db.forGym(f.gymId, tx => tx.insert(members).values(Array.from({ length: 105 }, (_, i) => ({ gymId: f.gymId,
    householdId: f.household.id, firstName: 'Bulk', lastName: String(i), status: 'active', email: `bulk${i}@example.test` }))));
  const row = await f.send(); await f.run(row.id);
  expect(f.email.messages).toHaveLength(105);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ recipientCount: 105, status: 'sent', sent: 105 });
  f.clock.advance(1);
  const next = await f.send();
  expect(await f.service.list(f.gymId, { limit: 1 })).toMatchObject({ data: [{ id: next.id }], pagination: { total: 2, limit: 1, offset: 0 } });
  expect(await f.service.list(f.gymId, { limit: 1, offset: 1 })).toMatchObject({ data: [{ id: row.id }] });
});
it.each([{ status: 'cancelled' }, { anonymizedAt: new Date('2026-11-09T12:00:00Z') }, { email: null }, { emailDeliverable: false }])('rechecks a changed member before reservation: %j', async changes => {
  const f = await fixture(), member = await f.member(), row = await f.send();
  await db.forGym(f.gymId, tx => tx.update(members).set(changes).where(eq(members.id, member.id)));
  await f.run(row.id); expect(f.email.messages).toHaveLength(0);
  expect(await f.service.get(f.gymId, row.id)).toMatchObject({ skipped: 1, status: 'sent' });
});
it('captures demo sends and tests without resolving or calling SMTP', async () => {
  const f = await fixture(); await f.member();
  const service = createAnnouncementsService({ ...f.options, demoMode: true, demoEmailFor: id => new OutboxEmail(id, f.clock, db.forGym) });
  const row = await service.send(f.actor, f.input()); await service.run({ announcementId: row.id }, f.gymId); await service.test(f.actor, draft);
  expect(f.options.mailer).not.toHaveBeenCalled(); expect(f.options.smtp.configured).not.toHaveBeenCalled();
  expect(await db.forGym(f.gymId, tx => tx.select().from(emailOutbox))).toHaveLength(2);
  expect(f.email.messages).toHaveLength(0);
});
it.each(['owner', 'admin', 'coach', 'front_desk'] as const)('enforces %s on preview, test, send, history and detail', async role => {
  const f = await fixture(role), manager = role === 'owner' || role === 'admin'; await f.member();
  for (const contract of Object.values(announcementsContracts)) {
    const path = contract.path.replace('{announcementId}', uuidv7());
    const response = await f.app().request(path, { method: contract.method.toUpperCase(), headers: { 'content-type': 'application/json' },
      ...(contract.method === 'post' ? { body: JSON.stringify(contract === announcementsContracts.send ? f.input() : draft) } : {}) });
    expect(response.status, path).toBe(manager ? contract === announcementsContracts.get ? 404 : 200 : 403);
  }
});
it('returns cross-gym 404 for an announcement and isolates the history and job', async () => {
  const a = await fixture(), b = await fixture(); await b.member(); const row = await b.send();
  expect((await a.app().request('/api/announcements/' + row.id)).status).toBe(404);
  expect(await a.service.list(a.gymId)).toMatchObject({ data: [] });
  await expect(a.service.run({ announcementId: row.id }, a.gymId)).rejects.toMatchObject({ code: 'not_found' });
  expect(a.email.messages).toHaveLength(0);
});
it('uses the production registrations for request, batch lane, delivery and history', async () => {
  const f = await fixture(); await f.member(); configureAnnouncements(f.service);
  const app = createApp({ clock: f.clock, skipSetup: true, authorize, origin, contributions: areaContributions,
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal: f.principal }); await next(); } });
  const response = await app.request(origin + '/api/announcements/send', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(f.input()) });
  expect(response.status).toBe(200);
  const row = announcementsContracts.send.response.parse(await response.json()).data;
  const registration = areaContributions.jobs.find(job => job.id === announcementSendJob)!;
  expect(registration.lane).toBe('batch');
  createServerRegistry({ jobs: createAnnouncementJobs(() => f.service) }).registerJobs(f.jobs, new Set());
  expect(f.jobs.batchJobs.has(announcementSendJob)).toBe(true);
  await registration.handler(f.jobs.jobs[0]!.payload, { gymId: f.gymId, jobId: 'test', timezone: 'UTC', attempt: 1, clock: f.clock });
  expect(f.email.messages).toHaveLength(1);
  const history = await app.request(origin + '/api/announcements/' + row.id);
  expect(announcementsContracts.get.response.parse(await history.json()).data).toMatchObject({ status: 'sent', sent: 1 });
});
