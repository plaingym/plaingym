// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Integration tests inspect persistent delivery keys and change the gym email switch in their isolated database.
import { auditEvents, emailDeliveries, gyms, invoices, jobs, members, memberships, paymentAttempts, paymentMethods, staffRoles as staffRoleTable, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, staffRoles, type StaffRole } from '@plaingym/shared';
import { matDashboardResponseSchema } from '@plaingym/shared/contracts';
import { addDays, localDate, zonedInstant } from '@plaingym/shared/time';
import { TestClock } from '../../../core/clock.js';
import type { Principal } from '../../../core/context.js';
import { createServerRegistry } from '../../../core/registry.js';
import { areaContributions } from '../../../core/registry-areas.js';
import { createApp } from '../../../app.js';
import { PostgresJobs } from '../../../infra/jobs/index.js';
import { DeliveryError, FakeEmail, SmtpEmail } from '../../../infra/email/index.js';
import { captureSmtp } from '../../../infra/email/test-smtp.js';
import { FakePayments } from '../../../infra/payments/index.js';
import { createAccountService } from '../../../infra/auth/accounts.js';
import { authConfig } from '../../../infra/auth/config.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createSignedLinksService } from '../../links/service.js';
import { createMembersService } from '../../members/members.js';
import { createRanksService } from '../../ranks/ranks.service.js';
import { createPromotionCriteria } from '../../ranks/criteria.js';
import { createAttendanceQueries } from '../../attendance/attendance.js';
import { configureDashboard } from '../../dashboard/dashboard.routes.js';
import { authorize } from '../../staff/auth.permissions.js';
import { createInvoiceTransitions } from '../transitions/index.js';
import { registerBillingWebhookHandlers } from '../webhooks/handlers/index.js';
import { createWebhookInbox } from '../webhooks/inbox.js';
import { createWebhookInboxJobs } from '../webhooks/inbox.jobs.js';
import { createBillingAlerts, createDisputeAlertProvider, sendAlertJob, type BillingAlertsOptions } from './index.js';
import { configureBillingAlerts, createBillingAlertJobs } from './alerts.jobs.js';

const db = useTestDatabase(), factory = createFactories(db);
const accounts = createAccountService(authConfig({ AUTH_SECRET: 'billing-alerts-test-secret-at-least-32-characters' }, false), () => db.system.db);
async function fixture(timezone = 'America/Vancouver', instant = '2026-11-01T17:00:00Z') {
  const gymId = uuidv7(), clock = new TestClock(instant);
  const gymName = 'Riverside Gym';
  await factory('gyms', gymId, { name: gymName, timezone, memberEmailsEnabled: true, billingEnabled: true });
  const household = await factory('households', gymId, { email: 'payer@example.invalid', stripeCustomerId: 'cus_test' });
  const member = await factory('members', gymId, { householdId: household.id, email: household.email });
  const membership = await factory('memberships', gymId, { householdId: household.id, memberId: member.id,
    status: 'active', nextDueOn: '2026-12-01', startsOn: '2026-01-01' });
  const card = await factory('paymentMethods', gymId, { householdId: household.id, isDefault: true, expiryMonth: 11, expiryYear: 2026 });
  const owner = await factory('authUser', gymId, { email: uuidv7() + '@example.invalid' });
  await factory('staffRoles', gymId, { userId: owner.id, role: 'owner' });
  const email = new FakeEmail(), settings = createGymSettingsAccessor({ scope: db.forGym });
  function compose(prepare?: BillingAlertsOptions['prepare']) {
    const queue = new PostgresJobs({ database: db, clock, listGyms: async () => [{ gymId, timezone }] });
    const alerts = createBillingAlerts({ scope: db.forGym, clock, jobs: queue, settings, accounts,
      prepare: prepare ?? (async () => ({ email, origin: 'https://gym.example.invalid', gymName })) });
    createServerRegistry({ jobs: createBillingAlertJobs(() => alerts) }).registerJobs(queue, new Set());
    return { queue, alerts };
  }
  const readJobs = () => db.forGym(gymId, tx => tx.select().from(jobs).where(eq(jobs.name, sendAlertJob)));
  const links = createSignedLinksService({ scope: db.forGym, clock });
  return { gymId, clock, timezone, household, member, membership, card, owner, email, settings, compose, readJobs, links, ...compose() };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function drain(queue: PostgresJobs) {
  for (let n = 0; n < 30; n++) if (!await queue.runNext()) return;
  throw new Error('Queue did not drain within 30 jobs');
}
const context = (f: Fixture) => ({ gymId: f.gymId, timezone: f.timezone, clock: f.clock, jobId: uuidv7(), attempt: 1 });

describe('billing alerts with the real PostgreSQL queue and RLS', () => {
  it('delivers one signed link per card and due-date cycle under concurrent scans, restart and replay', async () => {
    const f = await fixture();
    await Promise.all([f.alerts.cardExpiry(f.gymId), f.alerts.cardExpiry(f.gymId)]);
    expect(await f.readJobs()).toHaveLength(1);
    // Restart before delivery: a fresh process has no in-memory dedupe state.
    const restarted = f.compose();
    await restarted.alerts.cardExpiry(f.gymId);
    await drain(restarted.queue);
    await f.alerts.cardExpiry(f.gymId); await drain(f.queue);
    expect(await f.readJobs()).toMatchObject([{ status: 'succeeded', attempts: 1 }]);
    expect(f.email.messages).toHaveLength(1);
    const sent = f.email.messages[0]!;
    expect(sent.to).toBe(f.household.email);
    expect(sent.text).toContain('December 1, 2026');
    expect(sent.text).toContain('Riverside Gym');
    const token = sent.text.match(/https:\/\/gym\.example\.invalid\/l\/([\w-]+)/)![1]!;
    expect(await f.links.resolve(f.gymId, token)).toMatchObject({ status: 'active', principal: {
      householdId: f.household.id, gymId: f.gymId, link: { purpose: 'update_card' },
    } });
    const other = await fixture();
    expect(await f.links.resolve(other.gymId, token)).toEqual({ status: 'not_found' });
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.alert.card_expiry.sent')));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(token);
    // The same physical card may warn again for a later billing cycle.
    await db.forGym(f.gymId, tx => tx.update(memberships).set({ nextDueOn: '2027-01-01' }).where(eq(memberships.id, f.membership.id)));
    f.clock.set('2026-12-02T17:00:00Z');
    await restarted.alerts.cardExpiry(f.gymId); await drain(restarted.queue);
    expect(await f.readJobs()).toHaveLength(2); expect(f.email.messages).toHaveLength(2);
  });
  it.each(['card', 'dispute'] as const)('waits for mail readiness without consuming the %s delivery key', async kind => {
    const f = await fixture();
    if (kind === 'dispute') await factory('invoices', f.gymId, { disputeId: 'dp_ready', disputeStatus: 'open' });
    const prepare = vi.fn<BillingAlertsOptions['prepare']>().mockRejectedValue(new AppError('unavailable', 'Email is not configured for this gym'));
    const { alerts, queue } = f.compose(prepare), enqueue = vi.spyOn(queue, 'enqueue');
    const scan = () => kind === 'card' ? alerts.cardExpiry(f.gymId) : alerts.disputes(f.gymId);
    await scan();
    expect(prepare).toHaveBeenCalledTimes(1); expect(enqueue).not.toHaveBeenCalled();
    expect(await f.readJobs()).toHaveLength(0);
    prepare.mockResolvedValue({ email: f.email, origin: 'https://gym.example.invalid/subpath', gymName: 'Riverside Gym' });
    await scan();
    expect(enqueue).not.toHaveBeenCalled(); expect(await f.readJobs()).toHaveLength(0);
    prepare.mockResolvedValue({ email: f.email, origin: 'https://gym.example.invalid', gymName: 'Riverside Gym' });
    await scan(); await drain(queue); await scan(); await drain(queue);
    expect(f.email.messages).toHaveLength(1);
    expect(await f.readJobs()).toMatchObject([{ status: 'succeeded', attempts: 1 }]);
    expect(f.email.messages[0]!.text).toContain('Riverside Gym');
  });
  it('waits for an owner before reserving a dispute delivery key', async () => {
    const f = await fixture();
    await factory('invoices', f.gymId, { disputeId: 'dp_owner', disputeStatus: 'open' });
    await db.forGym(f.gymId, tx => tx.delete(staffRoleTable).where(eq(staffRoleTable.userId, f.owner.id)));
    const enqueue = vi.spyOn(f.queue, 'enqueue');
    await f.alerts.disputes(f.gymId);
    expect(enqueue).not.toHaveBeenCalled(); expect(await f.readJobs()).toHaveLength(0);
    await factory('staffRoles', f.gymId, { userId: f.owner.id, role: 'owner' });
    await f.alerts.disputes(f.gymId); await drain(f.queue);
    expect(f.email.messages).toHaveLength(1); expect(f.email.messages[0]!.to).toBe(f.owner.email);
    expect(await f.readJobs()).toMatchObject([{ status: 'succeeded', attempts: 1 }]);
  });
  it.each(['card', 'dispute', 'suppressed dispute'] as const)('retries a transient %s send failure after restarting the worker', async kind => {
    const f = await fixture();
    if (kind !== 'card') await factory('invoices', f.gymId, { disputeId: 'dp_transient', disputeStatus: 'open' });
    // Only a definite non-send is retried; DeliveryError proves no recipient got the message.
    f.email.respondNext(kind === 'suppressed dispute' ? { status: 'suppressed', reason: 'disabled' }
      : new DeliveryError('not_accepted', 'Temporary SMTP outage'));
    if (kind === 'card') await f.alerts.cardExpiry(f.gymId); else await f.alerts.disputes(f.gymId);
    await drain(f.queue);
    expect(f.email.messages).toHaveLength(0);
    const [retry] = await f.readJobs(); expect(retry).toMatchObject({ status: 'pending', attempts: 1 });
    f.clock.set(retry!.runAt);
    await drain(f.compose().queue);
    expect(f.email.messages).toHaveLength(1);
    expect(await f.readJobs()).toMatchObject([{ status: 'succeeded', attempts: 2 }]);
    if (kind === 'card') expect((await f.links.list(f.gymId)).data.filter(link => !link.revokedAt)).toHaveLength(1);
  });
  it.each(['card', 'dispute'] as const)('never resends a %s alert SMTP accepted when the worker was lost before recording it', async kind => {
    const f = await fixture();
    if (kind === 'dispute') await factory('invoices', f.gymId, { disputeId: 'dp_accepted', disputeStatus: 'open' });
    const send = f.email.sendEmail.bind(f.email);
    // SMTP accepted the message, then the worker lost its lease before the outcome was written.
    vi.spyOn(f.email, 'sendEmail').mockImplementationOnce(async message => { await send(message); throw new Error('Worker lease lost'); });
    if (kind === 'card') await f.alerts.cardExpiry(f.gymId); else await f.alerts.disputes(f.gymId);
    await drain(f.queue);
    expect(f.email.messages).toHaveLength(1);
    if (kind === 'card') {
      const [retry] = await f.readJobs(); expect(retry).toMatchObject({ status: 'pending', attempts: 1 });
      f.clock.set(retry!.runAt);
      await drain(f.compose().queue);
      expect(await f.readJobs()).toMatchObject([{ status: 'succeeded', attempts: 2 }]);
      // The member may hold the first link, so it stays usable and no second one is minted.
      expect((await f.links.list(f.gymId)).data).toMatchObject([{ revokedAt: null }]);
    } else {
      // The possibly delivered dispute notice is audited as uncertain, so neither the job nor the scan resends it.
      expect(await f.readJobs()).toMatchObject([{ status: 'succeeded', attempts: 1 }]);
      expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.alert.dispute.uncertain'))))
        .toMatchObject([{ after: { disputeId: 'dp_accepted' } }]);
      const enqueue = vi.spyOn(f.queue, 'enqueue');
      await f.alerts.disputes(f.gymId);
      expect(enqueue).not.toHaveBeenCalled();
    }
    expect(f.email.messages).toHaveLength(1);
  });
  it.each(['card', 'dispute'] as const)('treats a %s alert recorded as accepted but never audited as delivered', async kind => {
    const f = await fixture();
    if (kind === 'dispute') await factory('invoices', f.gymId, { disputeId: 'dp_unaudited', disputeStatus: 'open' });
    const key = kind === 'card' ? `billing.alert.card_expiry:${f.card.id}:${f.membership.nextDueOn}` : 'billing.alert.dispute:dp_unaudited';
    // A crash between recording acceptance and the audit, after which the job row itself was retried.
    await db.forGym(f.gymId, tx => tx.insert(emailDeliveries).values({ gymId: f.gymId, key, state: 'accepted', updatedAt: f.clock.now() }));
    if (kind === 'card') await f.alerts.cardExpiry(f.gymId); else await f.alerts.disputes(f.gymId);
    await drain(f.queue);
    expect(f.email.messages).toHaveLength(0);
    expect(await f.readJobs()).toMatchObject([{ status: 'succeeded', attempts: 1 }]);
    const action = `billing.alert.${kind === 'card' ? 'card_expiry' : 'dispute'}.sent`;
    // The accepted notice is audited now, once.
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, action)))).toHaveLength(1);
    if (kind === 'card') expect((await f.links.list(f.gymId)).data).toHaveLength(0);
    else {
      // The dispute scan stops finding it.
      const enqueue = vi.spyOn(f.queue, 'enqueue');
      await f.alerts.disputes(f.gymId);
      expect(enqueue).not.toHaveBeenCalled();
    }
  });
  it('never resends a dispute alert one owner rejected after another accepted it', async () => {
    const f = await fixture(), capture = await captureSmtp();
    const smtp = new SmtpEmail({ host: '127.0.0.1', port: capture.port, security: 'plain', from: 'desk@example.invalid' });
    try {
      const second = await factory('authUser', f.gymId, { email: uuidv7() + '@example.invalid' });
      await factory('staffRoles', f.gymId, { userId: second.id, role: 'owner' });
      await factory('invoices', f.gymId, { disputeId: 'dp_partial', disputeStatus: 'open' });
      const { alerts, queue } = f.compose(async () => ({ email: smtp, origin: 'https://gym.example.invalid', gymName: 'Riverside Gym' }));
      capture.rejectRecipient(second.email);
      await alerts.disputes(f.gymId); await drain(queue);
      capture.rejectRecipient(false);
      // The first owner already has it; resending would duplicate it, so the outcome stays unknown.
      expect(capture.messages).toHaveLength(1);
      expect(await f.readJobs()).toMatchObject([{ status: 'succeeded', attempts: 1 }]);
      expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.alert.dispute.sent')))).toHaveLength(0);
      expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.alert.dispute.uncertain')))).toHaveLength(1);
      await alerts.disputes(f.gymId); await drain(queue);
      expect(capture.messages).toHaveLength(1);
      expect(await f.readJobs()).toHaveLength(1);
    } finally { smtp.close(); await capture.close(); }
  });
  it('keeps a card link usable and sends nothing more when its delivery outcome is unknown', async () => {
    const f = await fixture();
    f.email.respondNext(new DeliveryError('unknown', 'SMTP delivery outcome is unknown'));
    await f.alerts.cardExpiry(f.gymId); await drain(f.queue);
    const [retry] = await f.readJobs(); expect(retry).toMatchObject({ status: 'pending', attempts: 1 });
    f.clock.set(retry!.runAt);
    await drain(f.compose().queue);
    expect(f.email.messages).toHaveLength(0);
    expect(await f.readJobs()).toMatchObject([{ status: 'succeeded', attempts: 2 }]);
    // The member may have received this link, so it is neither revoked nor replaced.
    expect((await f.links.list(f.gymId)).data).toMatchObject([{ revokedAt: null }]);
  });
  it.each(['card', 'dispute'] as const)('keeps the %s retry budget alive through its required delivery window', async kind => {
    const f = await fixture('UTC', '2026-11-01T09:00:00Z');
    if (kind === 'dispute') await factory('invoices', f.gymId, { disputeId: 'dp_outage', disputeStatus: 'open' });
    const recoverAt = kind === 'card' ? zonedInstant(f.membership.nextDueOn, '00:00', 'UTC', { gap: 'shift' })!
      : zonedInstant(addDays(localDate(f.clock.now(), 'UTC'), 1), '09:00', 'UTC', { gap: 'shift' })!;
    const prepare = vi.fn<BillingAlertsOptions['prepare']>().mockResolvedValue({
      email: f.email, origin: 'https://gym.example.invalid', gymName: 'Riverside Gym' });
    const { alerts, queue } = f.compose(prepare);
    if (kind === 'card') await alerts.cardExpiry(f.gymId); else await alerts.disputes(f.gymId);
    prepare.mockImplementation(async () => {
      if (f.clock.now() < recoverAt) throw new AppError('unavailable', 'SMTP temporarily unconfigured');
      return { email: f.email, origin: 'https://gym.example.invalid', gymName: 'Riverside Gym' };
    });
    // Exercise the real queue's backoff instead of calculating another copy of it in the test.
    for (let n = 0; n < 50; n++) {
      const [row] = await f.readJobs();
      if (row!.status === 'succeeded') break;
      expect(row!.status).toBe('pending');
      f.clock.set(row!.runAt);
      await queue.runNext();
    }
    expect(f.clock.now() >= recoverAt).toBe(true);
    expect(f.email.messages).toHaveLength(1);
    expect(await f.readJobs()).toMatchObject([{ status: 'succeeded' }]);
    if (kind === 'card') expect(localDate(f.clock.now(), 'UTC')).toBe(f.membership.nextDueOn);
  }, 60_000);
  it('does not enqueue already-alerted disputes, matching audit type, action, gym and dispute identity', async () => {
    const f = await fixture(), foreign = await fixture();
    const invoice = await factory('invoices', f.gymId, { disputeId: 'dp_scan', disputeStatus: 'open' });
    const event = { targetId: invoice.id, targetType: 'invoice', action: 'billing.alert.dispute.sent', after: { disputeId: 'dp_scan' } };
    await factory('auditEvents', foreign.gymId, event);
    await factory('auditEvents', f.gymId, { ...event, targetType: 'household' });
    await factory('auditEvents', f.gymId, { ...event, action: 'billing.alert.card_expiry.sent' });
    await factory('auditEvents', f.gymId, { ...event, after: { disputeId: 'dp_old' } });
    const enqueue = vi.spyOn(f.queue, 'enqueue');
    await f.alerts.disputes(f.gymId); await drain(f.queue);
    expect(enqueue).toHaveBeenCalledTimes(1); expect(f.email.messages).toHaveLength(1);
    enqueue.mockClear();
    await f.alerts.disputes(f.gymId);
    expect(enqueue).not.toHaveBeenCalled();
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ disputeId: 'dp_next' }).where(eq(invoices.id, invoice.id)));
    await f.alerts.disputes(f.gymId); await drain(f.queue);
    expect(enqueue).toHaveBeenCalledTimes(1); expect(f.email.messages).toHaveLength(2);
  });
  it('schedules dispute scans hourly at minute 41', () => {
    expect(createBillingAlertJobs().find(job => job.id === 'billing.alerts.disputes')?.cron).toBe('41 * * * *');
  });
  it.each(['replaced', 'revoked'] as const)('skips a card %s after enqueue and before the send', async change => {
    const f = await fixture(); await f.alerts.cardExpiry(f.gymId);
    await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ isDefault: false,
      ...(change === 'revoked' ? { revokedAt: f.clock.now() } : {}) }).where(eq(paymentMethods.id, f.card.id)));
    if (change === 'replaced') await factory('paymentMethods', f.gymId, {
      householdId: f.household.id, isDefault: true, expiryMonth: 12, expiryYear: 2030,
    });
    await drain(f.queue); expect(f.email.messages).toHaveLength(0);
    expect((await f.links.list(f.gymId)).data).toHaveLength(0);
  });
  it('uses the earliest bill and ignores cancelled, frozen, free and non-default cards', async () => {
    const f = await fixture();
    await factory('memberships', f.gymId, { householdId: f.household.id, memberId: f.member.id, status: 'active', nextDueOn: '2026-11-15' });
    await factory('paymentMethods', f.gymId, { householdId: f.household.id, expiryMonth: 1, expiryYear: 2020 });
    await f.alerts.cardExpiry(f.gymId); expect(await f.readJobs()).toHaveLength(0);
    await db.forGym(f.gymId, tx => tx.update(memberships).set({ status: 'cancelled' }).where(eq(memberships.householdId, f.household.id)));
    await factory('memberships', f.gymId, { householdId: f.household.id, memberId: f.member.id, status: 'frozen', nextDueOn: '2026-12-01' });
    await factory('memberships', f.gymId, { householdId: f.household.id, memberId: f.member.id, status: 'active', amountCents: 0, nextDueOn: '2026-12-01' });
    await f.alerts.cardExpiry(f.gymId); expect(await f.readJobs()).toHaveLength(0);
  });
  it.each(['switch', 'opt_out', 'undeliverable'] as const)('rechecks %s after enqueue', async change => {
    const f = await fixture(); await f.alerts.cardExpiry(f.gymId);
    await db.forGym(f.gymId, async tx => {
      if (change === 'switch') await tx.update(gyms).set({ memberEmailsEnabled: false }).where(eq(gyms.id, f.gymId));
      else await tx.update(members).set(change === 'opt_out' ? { emailOptOut: true } : { emailDeliverable: false }).where(eq(members.id, f.member.id));
    });
    await drain(f.queue); expect(f.email.messages).toHaveLength(0);
    expect((await f.links.list(f.gymId)).data).toHaveLength(0);
  });
  it('revokes an undisclosed link after suppression and notices a replacement during preparation', async () => {
    const f = await fixture(); f.email.respondNext({ status: 'suppressed', reason: 'disabled' });
    await f.alerts.cardExpiry(f.gymId); await drain(f.queue);
    expect(f.email.messages).toHaveLength(0);
    expect((await f.links.list(f.gymId)).data).toMatchObject([{ revokedAt: f.clock.now().toISOString() }]);
    const g = await fixture();
    let preparations = 0;
    const prepared = g.compose(async () => {
      if (++preparations === 2) await db.forGym(g.gymId, tx => tx.update(paymentMethods).set({ isDefault: false }).where(eq(paymentMethods.id, g.card.id)));
      return { email: g.email, origin: 'https://gym.example.invalid' };
    });
    await prepared.alerts.cardExpiry(g.gymId); await drain(prepared.queue);
    expect(g.email.messages).toHaveLength(0);
    expect((await g.links.list(g.gymId)).data).toMatchObject([{ revokedAt: g.clock.now().toISOString() }]);
  });
  it('registers the real area jobs and schedules the daily scan at 09:00 in the gym timezone across DST', async () => {
    const timezone = 'America/New_York';
    const f = await fixture(timezone, zonedInstant('2026-11-01', '08:59', timezone, { gap: 'shift' })!.toISOString());
    const queue = new PostgresJobs({ database: db, clock: f.clock, listGyms: async () => [{ gymId: f.gymId, timezone: f.timezone }] });
    configureBillingAlerts(createBillingAlerts({ scope: db.forGym, clock: f.clock, jobs: queue, settings: f.settings, accounts,
      prepare: async () => ({ email: f.email, origin: 'https://gym.example.invalid' }) }));
    // Production area registrations, including the static handlers configured by runtime.
    createServerRegistry({ jobs: areaContributions.jobs!.filter(job => job.id.startsWith('billing.alerts.')) }).registerJobs(queue, new Set());
    await queue.scheduleDue(); await drain(queue); expect(f.email.messages).toHaveLength(0);
    f.clock.set(zonedInstant('2026-11-01', '09:00', timezone, { gap: 'shift' })!); await queue.scheduleDue(); await drain(queue);
    const scheduled = await db.forGym(f.gymId, tx => tx.select().from(jobs));
    expect(scheduled.filter(job => job.status !== 'succeeded').map(job => ({ name: job.name, error: job.lastError }))).toEqual([]);
    expect(scheduled.filter(job => job.name === 'billing.alerts.card_expiry')).toHaveLength(1);
    expect(f.email.messages).toHaveLength(1);
    await queue.scheduleDue(); await drain(queue); expect(f.email.messages).toHaveLength(1);
  });
  it('keeps card delivery and dashboard counts inside the job gym', async () => {
    const a = await fixture(), b = await fixture();
    await a.alerts.send({ kind: 'card_expiry', paymentMethodId: b.card.id, cycle: '2026-12-01' }, context(a));
    await a.alerts.cardExpiry(a.gymId); await drain(a.queue);
    expect(a.email.messages).toHaveLength(1); expect(b.email.messages).toHaveLength(0);
    expect(await b.readJobs()).toHaveLength(0);
    const foreign = await factory('invoices', b.gymId, { disputeId: 'dp_foreign', disputeStatus: 'needs_response' });
    await a.alerts.send({ kind: 'dispute', invoiceId: foreign.id, disputeId: 'dp_foreign' }, context(a));
    expect(a.email.messages).toHaveLength(1); expect(b.email.messages).toHaveLength(0);
    for (const gymId of [a.gymId, b.gymId]) {
      const audits = await db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.alert.dispute.sent')));
      expect(audits).toHaveLength(0);
    }
    const provider = createDisputeAlertProvider({ scope: db.forGym });
    expect(await provider.read({ gymId: a.gymId, roles: ['owner'], clock: a.clock })).toHaveProperty('count', 0);
  });
  it.each(['won', 'lost', 'closed'] as const)('sends one owner notice under webhook replay and excludes a %s dispute from the unresolved count', async terminal => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ memberEmailsEnabled: false }).where(eq(gyms.id, f.gymId)));
    const secondOwner = await factory('authUser', f.gymId);
    await factory('staffRoles', f.gymId, { userId: secondOwner.id, role: 'owner' });
    const admin = await factory('authUser', f.gymId); await factory('staffRoles', f.gymId, { userId: admin.id, role: 'admin' });
    const invoice = await factory('invoices', f.gymId, { householdId: f.household.id, status: 'paid', paidAt: f.clock.now(), number: 1 });
    const attempt = await factory('paymentAttempts', f.gymId, { invoiceId: invoice.id });
    const provider = new FakePayments(f.gymId, f.clock);
    const intent = await provider.createCharge({ amount: invoice.amountCents, currency: invoice.currency.toLowerCase(),
      customerId: 'cus_test', paymentMethodId: f.card.processorId, invoiceId: invoice.id, attemptId: attempt.id, idempotencyKey: 'alert-test:create' });
    const paid = await provider.confirmCharge(intent.id, { idempotencyKey: 'alert-test:confirm' });
    if (paid.status !== 'succeeded') throw new Error('Expected paid fixture');
    await factory('payments', f.gymId, { invoiceId: invoice.id, method: 'card', paymentIntentId: intent.id, chargeId: paid.latestChargeId });
    await db.forGym(f.gymId, tx => tx.update(paymentAttempts).set({ paymentIntentId: intent.id }).where(eq(paymentAttempts.id, attempt.id)));
    const disputeId = 'dp_' + uuidv7();
    provider.recordDispute({ id: disputeId, chargeId: intent.id, status: 'open', amount: invoice.amountCents });
    const inbox = createWebhookInbox({ scope: db.forGym, system: db.forSystem, clock: f.clock, jobs: f.queue,
      gymSettings: f.settings, paymentsFor: async () => provider });
    registerBillingWebhookHandlers(inbox, { scope: db.forGym, clock: f.clock,
      transitions: createInvoiceTransitions({ scope: db.forGym, clock: f.clock }) });
    createServerRegistry({ jobs: createWebhookInboxJobs(inbox) }).registerJobs(f.queue, new Set());
    const eventId = 'evt_' + uuidv7(), body = new TextEncoder().encode(JSON.stringify({ id: eventId,
      type: 'charge.dispute.created', gymId: f.gymId, objectKind: 'dispute', objectId: disputeId }));
    await inbox.receive(f.gymId, body, provider.signWebhook(body)); await drain(f.queue);
    await Promise.all([f.alerts.disputes(f.gymId), f.alerts.disputes(f.gymId)]); await drain(f.queue);
    await inbox.receive(f.gymId, body, provider.signWebhook(body)); await inbox.replay(f.gymId, eventId); await drain(f.queue);
    const restarted = f.compose(); await restarted.alerts.disputes(f.gymId); await drain(restarted.queue);
    expect(await f.readJobs()).toHaveLength(1); expect(f.email.messages).toHaveLength(1);
    expect(f.email.messages[0]!.to.split(', ').sort()).toEqual([f.owner.email, secondOwner.email].sort());
    expect(f.email.messages[0]!.to).not.toContain(admin.email);
    expect(f.email.messages[0]!.text).toContain('https://gym.example.invalid/admin/billing/invoices/' + invoice.id);
    const widget = createDisputeAlertProvider({ scope: db.forGym }), read = () => widget.read({ gymId: f.gymId, clock: f.clock, roles: ['owner'] });
    expect(await read()).toHaveProperty('count', 1);
    provider.recordDispute({ id: disputeId, chargeId: intent.id, status: terminal, amount: invoice.amountCents });
    await inbox.replay(f.gymId, eventId); await drain(f.queue);
    // TODO: allow the provider and registry to omit a zero-count widget.
    expect(await read()).toHaveProperty('count', 0);
    await restarted.alerts.disputes(f.gymId); await drain(restarted.queue);
    expect(f.email.messages).toHaveLength(1);
  });
  it('filters the dashboard extension by permission through createApp and the production registrations', async () => {
    const f = await fixture();
    await factory('invoices', f.gymId, { disputeId: 'dp_local', disputeStatus: 'needs_response' });
    const foreign = await fixture(); await factory('invoices', foreign.gymId, { disputeId: 'dp_foreign', disputeStatus: 'needs_response' });
    const provider = createDisputeAlertProvider({ scope: db.forGym }), read = vi.spyOn(provider, 'read');
    const attendance = createAttendanceQueries({ scope: db.forGym, clock: f.clock });
    configureDashboard({ members: createMembersService({ scope: db.forGym, clock: f.clock }),
      ranks: createRanksService({ scope: db.forGym, clock: f.clock, criteria: createPromotionCriteria(attendance) }), attendance }, [provider]);
    let principal: Principal = { kind: 'anonymous' };
    const app = createApp({ contributions: areaContributions, clock: f.clock, authorize, setupToken: 'test-setup-token',
      resolveGym: async (c, next) => { c.set('context', { ...c.get('context'),
        gym: { gymId: f.gymId, timezone: f.timezone, enabledModules: new Set() } }); await next(); },
      session: async (c, next) => { c.set('context', { ...c.get('context'), principal }); await next(); } });
    for (const role of staffRoles) {
      read.mockClear(); principal = { kind: 'staff', gymId: f.gymId, userId: f.owner.id, roles: [role] };
      const response = await app.request('/api/dashboard'); expect(response.status).toBe(200);
      const { data } = matDashboardResponseSchema.parse(await response.json());
      const flag = data.widgets.find(widget => widget.id === 'billing.disputes');
      if (role === 'owner' || role === 'admin' || role === 'front_desk') expect(flag).toHaveProperty('count', 1);
      else { expect(flag).toBeUndefined(); expect(read).not.toHaveBeenCalled(); }
    }
    const denied: Principal[] = [{ kind: 'anonymous' }, { kind: 'member', userId: f.owner.id,
      scope: { gymId: f.gymId, householdId: f.household.id, role: 'payer' } },
    { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() },
    { kind: 'signed_link', gymId: f.gymId, householdId: f.household.id, linkId: uuidv7(), link: { purpose: 'update_card' } },
    { kind: 'staff', gymId: foreign.gymId, userId: foreign.owner.id, roles: ['owner'] }];
    for (principal of denied) expect((await app.request('/api/dashboard')).status).toBe(principal.kind === 'anonymous' ? 401 : 403);
    await expect(provider.read({ gymId: f.gymId, roles: ['coach'] as StaffRole[], clock: f.clock })).rejects.toMatchObject({ code: 'forbidden' });
    await factory('invoices', f.gymId, { disputeId: 'dp_unknown', disputeStatus: null });
    expect(await provider.read({ gymId: f.gymId, roles: ['owner'], clock: f.clock })).toHaveProperty('count', 2);
  });
});
