// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { TestClock } from '../../core/clock.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { createGymDeleteService } from '../../areas/settings/gym-delete.js';
import { createDemoService } from '../service.js';
import { billingSeed } from './billing.js';
import type { BillingSeedProvider } from './billing-payments.js';
import { membersSeed } from './members.js';
import { runSeeds } from './index.js';
import { fixture, provider, snapshot } from './billing.fixture.test-helper.js';

const db = useTestDatabase();

describe('demo billing seed providers and sandbox creation', { timeout: 90_000 }, () => {
  it('rejects a live provider or a provider for another gym before changing any billing data', async () => {
    const f = await fixture(db), before = await snapshot(db, f.gymId);
    for (const gateway of [{ ...f.gateway, mode: 'live' }, { ...f.gateway, gymId: uuidv7() }]) {
      const seed = billingSeed({ scope: db.forGym, clock: f.clock, paymentsFor: async () => gateway as BillingSeedProvider });
      await expect(seed.run(f.context)).rejects.toThrow(/test mode/);
      expect(await snapshot(db, f.gymId)).toEqual(before);
    }
  });

  it('runs through sandbox creation with dependency injection and preserves a previously enabled billing switch', async () => {
    const clock = new TestClock('2026-10-26T16:00:00Z'), scope = db.forGym, system = db.forSystem;
    const gateways = new Map<string, ReturnType<typeof provider>>();
    const paymentsFor = async (gymId: string) => {
      const gateway = gateways.get(gymId) ?? provider(gymId, clock); gateways.set(gymId, gateway); return gateway;
    };
    const demo = createDemoService({ config: { enabled: true, domain: 'demo.example.test', maxSandboxes: 50 },
      key: parseEncryptionKey('cd'.repeat(32)), clock, scope, system,
      identities: { async seed() {}, async login() { return new Response(); } },
      deletion: createGymDeleteService({ clock, scope, system, removeUploads: async () => {} }),
      seed: context => runSeeds(context, [membersSeed({ scope, clock, pinSecret: null }), billingSeed({ scope, clock, paymentsFor })]),
    });
    const sandbox = await demo.create(), rows = await snapshot(db, sandbox.gymId);
    expect(rows.invoices.some(row => row.status === 'paid')).toBe(true);
    expect(rows.invoices.some(row => row.status === 'past_due')).toBe(true);
    expect(rows.gym.settings).toMatchObject({ demo: { ready: true } });
    const f = await fixture(db);
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ billingEnabled: true }).where(eq(gyms.id, f.gymId)));
    await f.seed.run(f.context); expect((await snapshot(db, f.gymId)).gym.billingEnabled).toBe(true);
    expect((await snapshot(db, f.gymId)).audit.filter(row => row.action === 'settings.go_live.updated')).toHaveLength(0);
  });
});
