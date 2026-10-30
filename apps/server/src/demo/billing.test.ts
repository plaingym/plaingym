// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, households, invoices, paymentMethods } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { createGymSettingsAccessor } from '../areas/settings/settings.js';
import { createWebhookInbox } from '../areas/billing/webhooks/inbox.js';
import { effectJob } from '../areas/billing/transitions/effects.js';
import { composeBillingWebhooks } from '../areas/billing/webhooks/handlers/composition.js';
import type { TransitionEffect } from '../areas/billing/transitions/store.js';
import { createSeedCommand } from './seed-cli.js';
import { fixture } from './billing.fixture.test-helper.js';

const db = useTestDatabase();

async function drain(queue: PostgresJobs) {
  for (let count = 0; count < 200; count++) if (!await queue.runNext()) return;
  throw new Error('Demo test job drain exceeded its bound');
}

it('creates a sandbox through the composed seeds with paid/past-due invoices, cards and day-3/7 retry jobs', async () => {
  const f = fixture(db, true), { gymId } = await f.service.create();
  const rows = await db.forGym(gymId, async tx => ({
    invoices: await tx.select().from(invoices), cards: await tx.select().from(paymentMethods),
    homes: await tx.select().from(households), gym: (await tx.select().from(gyms))[0]!,
  }));
  expect(rows.invoices.filter(row => row.status === 'paid').length).toBeGreaterThan(15);
  expect(rows.invoices.filter(row => row.status === 'past_due')).toHaveLength(2);
  // The 14 sample households and the one-click student's household (portal seed).
  expect(rows.cards).toHaveLength(15); expect(rows.cards.every(row => row.isDefault && !row.revokedAt)).toBe(true);
  expect(rows.homes.filter(row => row.stripeCustomerId)).toHaveLength(15);
  expect(rows.gym.stripeConfig).toBeNull(); expect(JSON.stringify(rows.gym)).not.toContain('rk_test_');
  expect(await f.payments.paymentsFor(gymId)).toBe(f.gateways.get(gymId)!.payments);
  const queue = new PostgresJobs({ clock: f.clock, database: db });
  const settings = createGymSettingsAccessor({ scope: db.forGym, clock: f.clock });
  const inbox = createWebhookInbox({ clock: f.clock, scope: db.forGym, system: db.forSystem, jobs: queue, gymSettings: settings, paymentsFor: f.payments.paymentsFor });
  const billing = composeBillingWebhooks({ inbox, jobs: queue, settings, scope: db.forGym, clock: f.clock, paymentsFor: f.payments.paymentsFor,
    prepare: async () => { throw new Error('No delivery while publishing effects'); }, staffRecipients: async () => [] });
  // The production runtime's existing publisher converts durable seed effects into ordinary jobs.
  await billing.effects.publish(gymId);
  const effects = await db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.transition.effect.created')));
  const retries = effects.filter(row => (row.after as TransitionEffect).kind === 'retry');
  expect(retries.map(row => (row.after as TransitionEffect).retryDay).sort()).toEqual([3, 3, 7, 7]);
  const retryIds = new Map(retries.map(row => [row.targetId, (row.after as TransitionEffect).retryDay]));
  const ran: number[] = [];
  queue.handle(effectJob, async payload => {
    const day = retryIds.get((payload as { effectId: string }).effectId);
    if (day) ran.push(day);
  });
  await drain(queue); expect(ran).toEqual([]);
  f.clock.set('2026-10-27T08:59:59Z'); expect(await queue.runNext()).toBe(false);
  f.clock.set('2026-10-27T09:00:00Z'); await drain(queue); expect(ran).toEqual([3, 3]);
  f.clock.set('2026-10-31T08:59:59Z'); expect(await queue.runNext()).toBe(false);
  f.clock.set('2026-10-31T09:00:00Z'); await drain(queue); expect(ran).toEqual([3, 3, 7, 7]);
  f.clock.set('2026-10-26T12:00:00Z');
  const stdout = vi.fn(), stderr = vi.fn();
  expect(await createSeedCommand(db.forGym, f.seed).run([gymId], { stdout, stderr })).toBe(0);
  expect(stderr).not.toHaveBeenCalled(); expect(stdout).toHaveBeenCalledWith('Seed complete');
  expect(await db.forGym(gymId, tx => tx.select().from(invoices))).toHaveLength(rows.invoices.length);
}, 90_000);
