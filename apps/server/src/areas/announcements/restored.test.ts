// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Isolated fixtures exercise the persisted member email and SMS switches.
import { auditEvents, classBookings, classSessions, emailDeliveries, gyms, members, smsDeliveries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createSmsPhoneDigest, FakeSms } from '../../infra/sms/index.js';
import { createScheduleService } from '../schedule/schedule.js';
import { createCancellationNotice } from './cancellation.js';
import { forgetErasedAddressDigests } from './erasure.js';
import { createAnnouncementJobs } from './jobs.js';
import { createRestoreNotice, restoreNoticeJob } from './restored.js';

const db = useTestDatabase(), factory = createFactories(db), phone = '+12025550123', own = '+12025550199';
const digest = createSmsPhoneDigest('restore-notice-test');
const ownText = 'Cedar Gym: Evening practice on 2026-11-10 at 7:30 PM EST is back on, and your place is restored. Check the schedule for it.';

/** Mia (booked) and Noa (waitlisted) share their household's consented billing email and phone; Ari (booked) has their own. */
async function fixture(scope: typeof db.forGym = db.forGym) {
  const gymId = uuidv7(), clock = new TestClock('2026-11-10T12:00:00Z');
  await factory('gyms', gymId, { name: 'Cedar Gym', settings: { address: { country: 'US' } }, timezone: 'America/New_York',
    memberEmailsEnabled: true, memberSmsEnabled: true });
  const user = await factory('authUser', gymId);
  await factory('staffRoles', gymId, { userId: user.id, role: 'owner' });
  const session = await factory('classSessions', gymId, { name: 'Evening practice', capacity: 5,
    startsAt: new Date('2026-11-11T00:30:00Z'), endsAt: new Date('2026-11-11T01:30:00Z') });
  await factory('classSessionPrograms', gymId, { sessionId: session.id });
  const home = await factory('households', gymId, { email: 'parent@example.test', phone, phoneE164: phone,
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
  const mia = await factory('members', gymId, { householdId: home.id, firstName: 'Mia', lastName: 'First' });
  const noa = await factory('members', gymId, { householdId: home.id, firstName: 'Noa', lastName: 'Second' });
  const ari = await factory('members', gymId, { firstName: 'Ari', lastName: 'Third', email: 'ari@example.test', phone: own, phoneE164: own,
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
  for (const [member, status] of [[mia, 'booked'], [noa, 'waitlisted'], [ari, 'booked']] as const)
    await factory('classBookings', gymId, { sessionId: session.id, memberId: member.id, bookedBy: user.id, status,
      waitlistPosition: status === 'waitlisted' ? 1 : null });
  const email = new FakeEmail(), sms = new FakeSms(), jobs = new FakeJobs(clock);
  const resolver = { resolve: vi.fn(async (id: string) => { expect(isInTransaction()).toBe(false); return { gymId: id, name: 'Cedar Gym', sms }; }),
    status: async () => ({ source: 'gym' as const, unreadable: false }), configured: async () => true };
  const options = { scope: db.forGym, clock, jobs, origin: async () => 'https://gym.example.test', demoMode: false,
    mailer: vi.fn(async () => { expect(isInTransaction()).toBe(false); return email; }), sms: { resolver, phoneDigest: digest } };
  const notice = createRestoreNotice(options), cancellation = createCancellationNotice(options);
  const service = createScheduleService({ scope, clock, restore: notice, cancellation });
  createServerRegistry({ jobs: createAnnouncementJobs(undefined, () => cancellation, () => notice) }).registerJobs(jobs, new Set());
  const actor = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const revision = async () => (await db.forGym(gymId, tx => tx.select().from(classSessions).where(eq(classSessions.id, session.id))))[0]!.revision;
  const cancel = async (notify = false) => service.changeSession(actor, session.id, 'cancel', { revision: await revision(), ...(notify ? { notify } : {}) });
  const restore = async (channels?: ('email' | 'sms')[]) =>
    service.restoreSession(actor, session.id, { revision: await revision(), notify: true, ...(channels ? { channels } : {}) });
  const restoreJobs = () => jobs.jobs.filter(job => job.name === restoreNoticeJob);
  const run = async () => { for (const job of restoreJobs()) await notice.run(job.payload, gymId); };
  const switches = (values: { memberEmailsEnabled?: boolean; memberSmsEnabled?: boolean }) =>
    db.forGym(gymId, tx => tx.update(gyms).set(values).where(eq(gyms.id, gymId)));
  const cancelPlace = (memberId: string) => db.forGym(gymId, tx => tx.update(classBookings).set({ status: 'cancelled', waitlistPosition: null, cancelledAt: clock.now() })
    .where(and(eq(classBookings.sessionId, session.id), eq(classBookings.memberId, memberId))));
  return { gymId, clock, session, mia, noa, ari, email, sms, jobs, notice, service, cancel, restore, restoreJobs, run, switches, cancelPlace };
}

it('queues the notice in the restore transaction, so a rollback leaves neither the restore nor its job', async () => {
  let failing = false;
  // The restore's transaction is the one returning the session response; fail it after all its writes.
  const scope: typeof db.forGym = (gymId, fn) => db.forGym(gymId, async tx => {
    const result = await fn(tx);
    if (failing && typeof result === 'object' && result !== null && 'cancelBefore' in result) throw new Error('Forced rollback');
    return result;
  });
  const f = await fixture(scope);
  await f.cancel();
  failing = true;
  await expect(f.restore()).rejects.toThrow('Forced rollback');
  expect(await db.forGym(f.gymId, tx => tx.select().from(classSessions))).toMatchObject([{ status: 'cancelled', restoreCount: 0 }]);
  const bookings = await db.forGym(f.gymId, tx => tx.select().from(classBookings));
  expect(bookings.every(row => row.status === 'cancelled' && row.sessionCancelStatus !== null)).toBe(true);
  expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, 'booking.restored')))).toBe(0);
  expect(f.restoreJobs()).toHaveLength(0);
  failing = false;
  await f.restore();
  expect(f.restoreJobs()).toMatchObject([{ payload: { sessionId: f.session.id, memberIds: [f.mia.id, f.noa.id, f.ari.id].sort(),
    channels: ['email', 'sms'], round: 1 }, options: { idempotencyKey: `schedule-restore-notice:${f.session.id}.1`, timezone: 'America/New_York' } }]);
});

it('emails each address group and texts each consented phone once, naming members only to a shared destination', async () => {
  const f = await fixture();
  await f.cancel(); await f.restore();
  expect(await f.jobs.runNext()).toBe(true);
  await f.run();
  expect(f.email.messages.map(message => message.to).sort()).toEqual(['ari@example.test', 'parent@example.test']);
  const parent = f.email.messages.find(message => message.to === 'parent@example.test')!;
  expect(parent.subject).toBe('Back on: Evening practice');
  for (const value of ['Evening practice on 2026-11-10 at 7:30 PM EST is going ahead after all.', 'Places restored for: Mia First, Noa Second',
    'https://gym.example.test/portal/schedule']) expect(parent.text).toContain(value);
  const ari = f.email.messages.find(message => message.to === 'ari@example.test')!;
  expect(ari.text).not.toContain('Places restored for'); expect(ari.text).not.toContain('Ari Third');
  expect(f.sms.messages.map(message => message.to).sort()).toEqual([phone, own].sort());
  expect(f.sms.messages.find(message => message.to === own)!.body).toBe(ownText);
  const shared = f.sms.messages.find(message => message.to === phone)!.body;
  for (const value of ['Evening practice', '2026-11-10', '7:30 PM EST', 'is back on', 'Mia First', 'Noa Second']) expect(shared).toContain(value);
  const emails = await db.forGym(f.gymId, tx => tx.select().from(emailDeliveries));
  expect(emails.map(row => row.key).sort()).toEqual([f.mia.id, f.ari.id].map(id => `schedule-restore-notice:${f.session.id}.1:${id}`).sort());
  const texts = await db.forGym(f.gymId, tx => tx.select().from(smsDeliveries));
  expect(texts.map(row => row.key).sort()).toEqual([f.mia.id, f.ari.id].map(id => `schedule-restore-sms:${f.session.id}.1:${id}`).sort());
  expect(JSON.stringify(texts)).not.toContain(phone);
  const decisions = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'schedule.restore_notice_decided')));
  expect(decisions.map(row => row.after)).toEqual(expect.arrayContaining([{ memberId: f.mia.id, round: 1, status: 'sent' }, { memberId: f.ari.id, round: 1, status: 'sent' }]));
  // A rerun, or a retry after a crash, sends nothing more.
  await f.run();
  expect(f.email.messages).toHaveLength(2); expect(f.sms.messages).toHaveLength(2);
});

it.each([['email'], ['sms']] as const)('reserves and sends only the chosen %s channel', async channel => {
  const f = await fixture();
  await f.cancel(); await f.restore([channel]);
  await f.run();
  expect(f.email.messages).toHaveLength(channel === 'email' ? 2 : 0);
  expect(f.sms.messages).toHaveLength(channel === 'sms' ? 2 : 0);
  expect(await db.forGym(f.gymId, tx => tx.$count(emailDeliveries))).toBe(channel === 'email' ? 2 : 0);
  expect(await db.forGym(f.gymId, tx => tx.$count(smsDeliveries))).toBe(channel === 'sms' ? 2 : 0);
});

it('tells only members who still hold their place when the job runs', async () => {
  const f = await fixture();
  await f.cancel(); await f.restore();
  await f.cancelPlace(f.ari.id); await f.cancelPlace(f.mia.id);
  await f.run();
  expect(f.email.messages.map(message => message.to)).toEqual(['parent@example.test']);
  expect(f.email.messages[0]!.text).toContain('Noa Second'); expect(f.email.messages[0]!.text).not.toContain('Mia First');
  expect(f.sms.messages.map(message => message.to)).toEqual([phone]);
  expect(f.sms.messages[0]!.body).not.toContain('Mia');
});

it.each(['cancelled again', 'started'] as const)('sends nothing once the session is %s', async change => {
  const f = await fixture();
  await f.cancel(); await f.restore();
  if (change === 'cancelled again') await f.cancel();
  else f.clock.set(f.session.startsAt);
  await f.run();
  expect(f.email.messages).toHaveLength(0); expect(f.sms.messages).toHaveLength(0);
  expect(await db.forGym(f.gymId, tx => tx.$count(emailDeliveries))).toBe(0);
  expect(await db.forGym(f.gymId, tx => tx.$count(smsDeliveries))).toBe(0);
});

it('suppresses a channel that is switched off or that the member opted out of', async () => {
  const off = await fixture();
  await off.cancel(); await off.restore();
  await off.switches({ memberEmailsEnabled: false });
  await off.run();
  expect(off.email.messages).toHaveLength(0); expect(off.sms.messages).toHaveLength(2);
  const quiet = await fixture();
  await quiet.cancel(); await quiet.restore();
  await quiet.switches({ memberSmsEnabled: false });
  await quiet.run();
  expect(quiet.email.messages).toHaveLength(2); expect(quiet.sms.messages).toHaveLength(0);
  const opted = await fixture();
  await opted.cancel(); await opted.restore();
  await db.forGym(opted.gymId, tx => tx.update(members).set({ emailOptOut: true, smsNoticesConsentAt: null, smsNoticesConsentSource: null })
    .where(eq(members.id, opted.ari.id)));
  await opted.run();
  expect(opted.email.messages.map(message => message.to)).toEqual(['parent@example.test']);
  expect(opted.sms.messages.map(message => message.to)).toEqual([phone]);
});

it('clears restore notice digests when a member is erased', async () => {
  const f = await fixture();
  await f.cancel(); await f.restore();
  await f.run();
  const digests = async () => ({
    email: Object.fromEntries((await db.forGym(f.gymId, tx => tx.select().from(emailDeliveries))).map(row => [row.key.split(':')[2], row.commandDigest])),
    sms: Object.fromEntries((await db.forGym(f.gymId, tx => tx.select().from(smsDeliveries))).map(row => [row.key.split(':')[2], row.commandDigest])),
  });
  expect(Object.values((await digests()).email).every(Boolean)).toBe(true);
  // Noa isn't the parent address's key, so only the address digest computed in SQL can find that record.
  await db.forGym(f.gymId, tx => forgetErasedAddressDigests(tx, f.gymId, f.noa.id, 'parent@example.test'));
  let after = await digests();
  expect(after.email[f.mia.id]).toBeNull(); expect(after.email[f.ari.id]).toBeTruthy();
  await db.forGym(f.gymId, tx => forgetErasedAddressDigests(tx, f.gymId, f.ari.id));
  after = await digests();
  expect(after.email[f.ari.id]).toBeNull(); expect(after.sms[f.ari.id]).toBeNull(); expect(after.sms[f.mia.id]).toBeTruthy();
});
