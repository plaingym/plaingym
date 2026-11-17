// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Integration tests edit gym switches and inspect their real queue.
import { gyms, households, jobs, signedLinks, smsDeliveries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import { createServerRegistry } from '../../../core/registry.js';
import { areaContributions } from '../../../core/registry-areas.js';
import { FakeEmail, DeliveryError } from '../../../infra/email/index.js';
import { PostgresJobs } from '../../../infra/jobs/index.js';
import { FakeSms } from '../../../infra/sms/index.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createBillingAlerts, sendAlertJob, sendCardSmsJob, type BillingAlertsOptions } from './index.js';
import { configureBillingAlerts, createBillingAlertJobs } from './alerts.jobs.js';
import { createCardExpirySms } from './sms.js';

const db = useTestDatabase(), make = createFactories(db), scope = db.forGym;
const origin = 'https://gym.example.invalid';
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-11-16T12:00:00Z'), timezone = 'America/Los_Angeles';
  await make('gyms', gymId, { name: 'Test Gym', timezone, address: { country: 'US' }, memberEmailsEnabled: true, memberSmsEnabled: true });
  const home = await make('households', gymId, { email: 'payer@example.invalid', phone: '+12025550123', phoneE164: '+12025550123',
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'portal' });
  const member = await make('members', gymId, { householdId: home.id });
  await make('memberships', gymId, { householdId: home.id, memberId: member.id, status: 'active', startsOn: '2026-01-01',
    nextDueOn: '2026-12-01', amountCents: 10000 });
  const card = await make('paymentMethods', gymId, { householdId: home.id, isDefault: true, expiryMonth: 11, expiryYear: 2026 });
  const email = new FakeEmail(), sms = new FakeSms(), settings = createGymSettingsAccessor({ scope });
  const prepare = vi.fn<BillingAlertsOptions['prepare']>(async () => ({ email, origin }));
  const smsPrepare = vi.fn(async () => ({ origin }));
  function compose(production = false) {
    const queue = new PostgresJobs({ database: db, clock });
    const alerts = createBillingAlerts({ scope, clock, jobs: queue, settings, prepare, accounts: { staffEmails: async () => [] },
      sms: createCardExpirySms({ scope, clock, settings, prepare: smsPrepare, resolver: {
        async resolve(id) { return { gymId: id, name: 'Test Gym', sms }; }, async configured() { return true; },
        async status() { return { source: 'gym', unreadable: false }; },
      } }) });
    if (production) {
      configureBillingAlerts(alerts);
      createServerRegistry({ jobs: areaContributions.jobs!.filter(job => job.id.startsWith('billing.alerts.')) }).registerJobs(queue, new Set());
    } else createServerRegistry({ jobs: createBillingAlertJobs(() => alerts) }).registerJobs(queue, new Set());
    return { alerts, queue };
  }
  async function drain(queue: PostgresJobs) {
    for (let n = 0; n < 10; n++) if (!await queue.runNext()) return;
    throw new Error('Queue did not drain');
  }
  const readJobs = () => scope(gymId, tx => tx.select().from(jobs));
  const change = (values: Partial<typeof gyms.$inferInsert>) => scope(gymId, tx => tx.update(gyms).set(values).where(eq(gyms.id, gymId)));
  return { gymId, clock, timezone, home, card, email, sms, settings, prepare, smsPrepare, compose, drain, readJobs, change };
}

it('leaves the email key unused until email is enabled mid-window, with independent SMS delivery', async () => {
  const f = await fixture(), { alerts, queue } = f.compose();
  await f.change({ memberEmailsEnabled: false });
  await alerts.cardExpiry(f.gymId); await f.drain(queue);
  expect(await f.readJobs()).toMatchObject([{ name: sendCardSmsJob, status: 'succeeded', attempts: 1 }]);
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.sms.messages).toHaveLength(1); expect(f.email.messages).toEqual([]);
  await f.change({ memberEmailsEnabled: true });
  const restarted = f.compose();
  await restarted.alerts.cardExpiry(f.gymId); await f.drain(restarted.queue);
  await restarted.alerts.cardExpiry(f.gymId); await f.drain(restarted.queue);
  expect(f.email.messages).toHaveLength(1); expect(f.sms.messages).toHaveLength(1);
  expect((await f.readJobs()).map(row => row.name).sort()).toEqual([sendAlertJob, sendCardSmsJob].sort());
  expect(f.email.messages[0]!.text).toContain('December 1, 2026');
  expect(f.sms.messages[0]!.body).toContain('December 1, 2026');
  expect(f.sms.messages[0]!.body).not.toContain('2026-12-01');
});

it('leaves the SMS key unused until SMS is enabled mid-window after email has completed', async () => {
  const f = await fixture(), { alerts, queue } = f.compose();
  await f.change({ memberSmsEnabled: false });
  await alerts.cardExpiry(f.gymId); await f.drain(queue);
  expect(await f.readJobs()).toMatchObject([{ name: sendAlertJob, status: 'succeeded', attempts: 1 }]);
  await f.change({ memberSmsEnabled: true });
  const restarted = f.compose();
  await restarted.alerts.cardExpiry(f.gymId); await f.drain(restarted.queue);
  await restarted.alerts.cardExpiry(f.gymId); await f.drain(restarted.queue);
  expect(f.email.messages).toHaveLength(1); expect(f.sms.messages).toHaveLength(1);
  const [row] = await scope(f.gymId, tx => tx.select().from(smsDeliveries));
  expect(row).toMatchObject({ key: `billing.alert.sms.card_expiry:${f.card.id}:2026-12-01:${f.home.id}`, state: 'accepted' });
});

it('uses production job registrations for an SMS-only gym without SMTP, and recovers email after SMTP is ready', async () => {
  const f = await fixture(), { alerts, queue } = f.compose(true);
  f.prepare.mockRejectedValue(new Error('SMTP unavailable'));
  await alerts.cardExpiry(f.gymId); await f.drain(queue);
  expect(await f.readJobs()).toMatchObject([{ name: sendCardSmsJob, status: 'succeeded', attempts: 1 }]);
  expect(f.sms.messages).toHaveLength(1); expect(f.email.messages).toEqual([]);
  f.prepare.mockResolvedValue({ email: f.email, origin });
  await alerts.cardExpiry(f.gymId); await f.drain(queue);
  expect(f.email.messages).toHaveLength(1); expect(f.sms.messages).toHaveLength(1);
  expect((await f.readJobs()).every(row => row.status === 'succeeded')).toBe(true);
});

it('scans and sends text-only cycles without a household email', async () => {
  const f = await fixture(), { alerts, queue } = f.compose();
  await f.change({ memberEmailsEnabled: false });
  await scope(f.gymId, tx => tx.update(households).set({ email: null }).where(eq(households.id, f.home.id)));
  await alerts.cardExpiry(f.gymId); await f.drain(queue);
  expect(f.sms.messages).toHaveLength(1); expect(f.prepare).not.toHaveBeenCalled();
  expect(await scope(f.gymId, tx => tx.select().from(signedLinks))).toHaveLength(1);
});

it('retries a refused email job without rerunning or blocking its completed SMS job', async () => {
  const f = await fixture(), { alerts, queue } = f.compose();
  f.email.respondNext(new DeliveryError('not_accepted', 'SMTP refused'));
  await alerts.cardExpiry(f.gymId); await f.drain(queue);
  expect(f.sms.messages).toHaveLength(1); expect(f.email.messages).toEqual([]);
  expect((await f.readJobs()).find(row => row.name === sendCardSmsJob)).toMatchObject({ status: 'succeeded', attempts: 1 });
  f.clock.advance(60_000);
  await f.drain(queue);
  expect(f.email.messages).toHaveLength(1); expect(f.sms.messages).toHaveLength(1);
});
