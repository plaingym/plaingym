// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { expect, it } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { zonedInstant } from '@plaingym/shared/time';
import { createCampaignsService } from '../../links/campaigns.js';
import { createCampaignJobs } from '../../links/campaigns.jobs.js';
import { origin, workflowFixture } from './workflow-fixture.js';

const db = useTestDatabase();

it('campaign card link completes from the signed webhook alone and receives no further reminders', async () => {
  const f = await workflowFixture(db, { empty: true });
  const waiting = await f.factory('households', f.gymId, { email: 'waiting@example.invalid' });
  await f.factory('members', f.gymId, { householdId: waiting.id });
  const campaigns = createCampaignsService({ ...f.common, paymentsFor: async () => f.provider,
    delivery: { prepare: async () => ({ gymId: f.gymId, gymName: 'Test Gym', origin, email: f.email,
      memberEmailsEnabled: true, t: createTranslator(locales.en ?? {}) }) } });
  for (const job of createCampaignJobs(() => campaigns)) f.queue.handle(job.id, job.handler);
  const { campaign } = await campaigns.create(f.context, { name: 'Collect updated cards', purpose: 'update_card',
    expiresAt: '2028-03-31T00:00:00Z', reminderSchedule: [3, 7], recipients: [{ householdId: f.home.id }, { householdId: waiting.id }] });
  await f.drain(); expect(f.email.messages).toHaveLength(2);
  const token = f.email.messages.find(m => m.to === f.home.email)!.text.match(/\/l\/([\w-]+)/)![1]!;
  const resolved = await f.links.resolve(f.gymId, token);
  if (resolved.status !== 'active') throw new Error('Campaign link was not delivered');
  const linkId = resolved.principal.linkId;
  const opened = await f.checkout.start(f.gymId, linkId);
  f.transport.completeCheckout(opened.session.id);
  // The member closes the tab: no browser-return completion call.
  const event = await f.deliver('checkout.session.completed', opened.session.id); await f.drain();
  const usedAt = (await f.links.get(f.gymId, linkId)).usedAt;
  expect(usedAt).not.toBeNull();
  expect((await campaigns.get(f.gymId, campaign.id)).progress).toMatchObject({ completed: 1, pending: 1 });
  expect((await f.read()).methods.find(m => m.isDefault)).toMatchObject({ processorId: 'pm_3155' });
  await f.deliver('checkout.session.completed', opened.session.id, event); await f.drain();
  await f.inbox.replay(f.gymId, event); await f.drain();
  expect((await f.links.get(f.gymId, linkId)).usedAt).toBe(usedAt);
  expect((await f.read()).audits.filter(a => a.action === 'signed_link.used' && a.targetId === linkId)).toHaveLength(1);
  for (const date of ['2028-03-04', '2028-03-08']) {
    f.clock.set(zonedInstant(date, '09:00', f.timezone, { gap: 'shift' })!);
    await f.runJob('links.campaigns.scan');
  }
  // The unfinished recipient proves the reminder worker actually ran beyond the Checkout hold.
  expect(f.email.messages.filter(m => m.to === waiting.email)).toHaveLength(3);
  expect(f.email.messages.filter(m => m.to === f.home.email)).toHaveLength(1);
  f.clock.set(zonedInstant('2028-03-09', '09:00', f.timezone, { gap: 'shift' })!);
  expect(await campaigns.remindCampaign(f.context, campaign.id)).toEqual({ queued: 1 }); await f.drain();
  expect(f.email.messages.filter(m => m.to === f.home.email)).toHaveLength(1);
  expect((await campaigns.get(f.gymId, campaign.id)).progress).toMatchObject({ completed: 1, pending: 1 });
});
