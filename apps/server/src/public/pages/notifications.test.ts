// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The test inspects the queued notice's payload and key in its isolated database.
import { jobs, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { areaContributions } from '../../core/registry-areas.js';
import { setLogSink } from '../../core/log.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { authConfig } from '../../infra/auth/config.js';
import { DeliveryError, FakeEmail } from '../../infra/email/index.js';
import { PostgresJobs } from '../../infra/jobs/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { createWaiversService } from '../../areas/waivers/waivers.js';
import { createPublicStaffNotices, staffNoticeJob, type PublicStaffNoticesOptions } from './notifications.js';
import { createPublicPagesJobs } from './pages.jobs.js';
import { createPublicPagesService } from './service.js';

const db = useTestDatabase(), factory = createFactories(db);
const accounts = createAccountService(authConfig({ AUTH_SECRET: 'public-notices-test-secret-at-least-32-characters' }, false), () => db.system.db);
const visitor = () => ({ contact: { name: 'Private Contact', email: 'visitor@example.invalid', phone: '555-0100' },
  member: { firstName: 'Private', lastName: 'Applicant', dateOfBirth: '1990-01-02' }, honeypot: '' });
async function fixture(prepare?: PublicStaffNoticesOptions['prepare']) {
  const gymId = uuidv7(), clock = new TestClock('2026-10-29T12:00:00Z'), timezone = 'America/Vancouver';
  // Member email is off: staff notices do not depend on the member switch.
  await factory('gyms', gymId, { name: 'North Gym', timezone, memberEmailsEnabled: false });
  const staff: Record<string, string> = {};
  for (const role of ['owner', 'admin', 'coach', 'front_desk'] as const) {
    const user = await factory('authUser', gymId, { email: `${role}-${uuidv7()}@example.invalid` });
    await factory('staffRoles', gymId, { userId: user.id, role });
    staff[role] = user.email;
  }
  const email = new FakeEmail(), queue = new PostgresJobs({ database: db, clock, listGyms: async () => [{ gymId, timezone }] });
  const notices = createPublicStaffNotices({ jobs: queue, accounts, scope: db.forGym, clock,
    prepare: prepare ?? (async () => ({ email, gymName: 'North Gym' })) });
  createServerRegistry({ jobs: createPublicPagesJobs(() => notices) }).registerJobs(queue, new Set());
  const uploadsFor = async (id: string) => new FakeUploads(id, clock);
  const pages = createPublicPagesService({ scope: db.forGym, clock, notifyStaff: notices.publish,
    waivers: createWaiversService({ scope: db.forGym, clock, uploadsFor }) });
  const readJobs = () => db.forGym(gymId, tx => tx.select().from(jobs).where(eq(jobs.name, staffNoticeJob)));
  async function drain() { for (let n = 0; n < 20; n++) if (!await queue.runNext()) return; throw new Error('Queue did not drain'); }
  return { gymId, clock, timezone, staff, email, queue, notices, pages, readJobs, drain };
}

describe('queued public staff notices', () => {
  it('queues a trial notice after commit with identifiers only, then mails owners and admins once', async () => {
    const f = await fixture();
    expect(await f.pages.trial(f.gymId, visitor(), f.timezone)).toEqual({ data: { status: 'received' } });
    // The request sent nothing itself; the queued payload carries no visitor details.
    expect(f.email.messages).toHaveLength(0);
    const [job] = await f.readJobs();
    expect(JSON.stringify(job)).not.toMatch(/visitor@example|Private|555-0100/);
    const [member] = await db.forGym(f.gymId, tx => tx.select().from(members));
    await f.drain();
    expect(f.email.messages.map(message => message.to).sort()).toEqual([f.staff.owner, f.staff.admin].sort());
    expect(f.email.messages[0]).toMatchObject({ subject: 'North Gym: Try a class' });
    expect(f.email.messages[0]!.text).toContain('Participant: Private Applicant');
    expect(f.email.messages[0]!.text).toContain('Email: visitor@example.invalid');
    expect(await f.readJobs()).toMatchObject([{ status: 'succeeded', attempts: 1 }]);
    // Replaying the publication reuses the same job key; nothing is sent twice.
    await f.notices.publish(f.gymId, { kind: 'trial', memberId: member!.id });
    await f.drain();
    expect(await f.readJobs()).toHaveLength(1);
    expect(f.email.messages).toHaveLength(2);
  });

  it('skips the notice quietly when the gym has no SMTP', async () => {
    const prepare = vi.fn<PublicStaffNoticesOptions['prepare']>().mockResolvedValue(null);
    const f = await fixture(prepare);
    await f.pages.trial(f.gymId, visitor(), f.timezone);
    await f.drain();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(f.email.messages).toHaveLength(0);
    expect(await f.readJobs()).toMatchObject([{ status: 'succeeded', attempts: 1 }]);
  });

  it('retries only the recipient a definite non-send missed, never one SMTP accepted or may have', async () => {
    const f = await fixture();
    const first = [f.staff.owner, f.staff.admin].map(to => to!.toLowerCase()).sort()[0];
    const sent: string[] = [], send = f.email.sendEmail.bind(f.email);
    let failures = 0;
    vi.spyOn(f.email, 'sendEmail').mockImplementation(async message => {
      if (message.to === first && failures++ === 0) throw new DeliveryError('not_accepted', 'SMTP connection failed');
      sent.push(message.to);
      return send(message);
    });
    await f.pages.trial(f.gymId, visitor(), f.timezone);
    await f.drain();
    const [retry] = await f.readJobs(); expect(retry).toMatchObject({ status: 'pending', attempts: 1 });
    expect(sent).toHaveLength(1);
    f.clock.set(retry!.runAt); await f.drain();
    expect(sent.sort()).toEqual([f.staff.owner, f.staff.admin].map(to => to!.toLowerCase()).sort());
    expect(await f.readJobs()).toMatchObject([{ status: 'succeeded', attempts: 2 }]);
  });

  it('never changes the visitor response or logs visitor details when publishing fails', async () => {
    const f = await fixture();
    vi.spyOn(f.queue, 'enqueue').mockRejectedValueOnce(new Error('Queue down for visitor@example.invalid Private Applicant'));
    const logs: string[] = [], previous = setLogSink(line => logs.push(line));
    try {
      expect(await f.pages.trial(f.gymId, visitor(), f.timezone, 'request-1')).toEqual({ data: { status: 'received' } });
    } finally { setLogSink(previous); }
    expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
      event: 'public.intake.notification_failed', gymId: f.gymId, kind: 'trial', requestId: 'request-1' }));
    expect(logs.join('\n')).not.toMatch(/visitor@example|Private|555-0100/);
    expect(await db.forGym(f.gymId, tx => tx.select().from(members))).toHaveLength(1);
  });

  it('sends nothing for an erased intake or another gym\'s member', async () => {
    const f = await fixture(), g = await fixture();
    await f.pages.trial(f.gymId, visitor(), f.timezone);
    const [member] = await db.forGym(f.gymId, tx => tx.select().from(members));
    await db.forGym(f.gymId, tx => tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, member!.id)));
    await f.drain();
    // Gym B's job cannot read gym A's member under row-level security.
    await g.notices.publish(g.gymId, { kind: 'drop-in', memberId: member!.id });
    await g.drain();
    expect(f.email.messages).toHaveLength(0);
    expect(g.email.messages).toHaveLength(0);
    expect(await g.readJobs()).toMatchObject([{ status: 'succeeded' }]);
  });

  it('registers the notice job with the public area and fails loudly when unconfigured', async () => {
    expect(areaContributions.jobs.map(job => job.id)).toContain(staffNoticeJob);
    const [job] = createPublicPagesJobs(() => undefined);
    await expect(job!.handler({ kind: 'trial', memberId: uuidv7() }, { gymId: uuidv7(), timezone: 'UTC', jobId: uuidv7(),
      attempt: 1, clock: new TestClock('2026-10-29T12:00:00Z') })).rejects.toThrow('Public staff notices are not configured');
  });
});
