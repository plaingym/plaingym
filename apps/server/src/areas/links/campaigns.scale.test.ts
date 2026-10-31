// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { households, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createTranslator } from '@plaingym/shared';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { createCampaignsService, campaignPublishJob, campaignSendJob } from './campaigns.js';
import { createCampaignJobs } from './campaigns.jobs.js';
import type { SignedLinkDelivery } from './service.delivery.js';

// Creating 2000 recipients takes seconds, so this test has a file of its own, apart from the campaign tests that share a fixture.
const db = useTestDatabase(), factory = createFactories(db);
const origin = 'https://gym.example.test';
const messages = JSON.parse(await readFile(new URL('../../../../../locales/en/links/service.json', import.meta.url), 'utf8')) as Record<string, string>;

it('creates 2000 recipients with only one publish job, then publishes once with audit batches of 100', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-10-26T12:00:00Z');
  await factory('gyms', gymId, { memberEmailsEnabled: true, billingEnabled: true, timezone: 'America/Los_Angeles' });
  const jobs = new FakeJobs(clock), email = new FakeEmail(), provider = new FakePayments(gymId, clock);
  const paymentsFor = vi.fn(async () => { expect(isInTransaction()).toBe(false); return provider; });
  const delivery: SignedLinkDelivery = { prepare: vi.fn(async (id: string) => {
    expect(isInTransaction()).toBe(false);
    return { gymId: id, gymName: 'Test Gym', origin, email, memberEmailsEnabled: true,
      t: createTranslator({ 'links/service': messages }) };
  }) };
  const people = await db.forGym(gymId, tx => tx.insert(households).values(Array.from({ length: 2000 }, (_, i) => ({
    gymId, name: 'Household ' + i, email: `payer${i}@example.test`,
  }))).returning({ id: households.id }));
  let transactions = 0;
  const service = createCampaignsService({ scope: async (id, fn) => { transactions++; return db.forGym(id, fn); },
    clock, jobs, delivery, paymentsFor });
  const enqueue = vi.spyOn(jobs, 'enqueue');
  const context = { gymId, actor: { kind: 'system' as const } };
  const c = await service.create(context, { name: 'Collect cards', purpose: 'update_card', expiresAt: '2026-11-26T12:00:00Z',
    reminderSchedule: [3, 7], recipients: people.map(p => ({ householdId: p.id })) });
  expect(enqueue).toHaveBeenCalledTimes(1); expect(jobs.jobs[0]!.name).toBe(campaignPublishJob);
  expect(transactions).toBe(3); // Definition, settings, and response; no recipient publication work.
  transactions = 0;
  const publish = createCampaignJobs(() => service).find(j => j.id === campaignPublishJob)!;
  await publish.handler({ campaignId: c.campaign.id }, { gymId, timezone: 'UTC', clock, jobId: uuidv7(), attempt: 1 });
  expect(transactions).toBe(23); // Settings, recipients, history, twenty audit batches.
  await service.publish({ campaignId: c.campaign.id }, gymId);
  const sends = jobs.jobs.filter(j => j.name === campaignSendJob);
  expect(sends).toHaveLength(2000); expect(new Set(sends.map(j => j.options.idempotencyKey)).size).toBe(2000);
  expect(email.messages).toHaveLength(0);
}, 90_000);
