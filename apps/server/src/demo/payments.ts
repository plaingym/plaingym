// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { forGym, forSystem, gyms } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { clock as defaultClock } from '../core/clock.js';
import { sandboxSettings, type DemoConfig } from './config.js';
import { billingSeedPayments, type BillingSeedProvider } from './seed/billing-payments.js';

/** The shared credential stays at install scope; every provider still enforces gym ownership. */
export function createDemoPayments(options: {
  config: DemoConfig; scope?: typeof forGym; system?: typeof forSystem; clock?: Clock;
  provider?: (gymId: string) => Promise<BillingSeedProvider>;
}) {
  const scope = options.scope ?? forGym, system = options.system ?? forSystem, clock = options.clock ?? defaultClock;
  const active = (gym: { status: string; settings: unknown }, ready: boolean) => {
    const sandbox = sandboxSettings(gym.settings);
    return gym.status === 'active' && sandbox && (!ready || sandbox.ready) && Date.parse(sandbox.expiresAt) > clock.now().getTime();
  };
  async function forSeed(gymId: string): Promise<BillingSeedProvider> {
    const stripe = options.config.stripe;
    if (!options.config.enabled || !stripe) throw new Error('Demo billing is not configured');
    const [gym] = await scope(gymId, tx => tx.select().from(gyms).where(eq(gyms.id, gymId)));
    if (!gym || !active(gym, false)) throw new Error('Demo billing requires an active sandbox');
    const provider = options.provider ? await options.provider(gymId) : billingSeedPayments({
      gymId, apiKey: stripe.testKey, webhookSecret: stripe.webhookSecret, clock,
    });
    if (provider.gymId !== gymId || provider.mode !== 'test') throw new Error('Demo billing requires this gym and test mode');
    return provider;
  }
  return {
    forSeed,
    async paymentsFor(gymId: string) {
      if (!options.config.enabled || !options.config.stripe) return null;
      const [gym] = await scope(gymId, tx => tx.select().from(gyms).where(eq(gyms.id, gymId)));
      return gym && active(gym, true) ? (await forSeed(gymId)).payments : null;
    },
    async demoGyms() {
      if (!options.config.enabled || !options.config.stripe) return [];
      const rows = await system(tx => tx.select({ gymId: gyms.id, status: gyms.status, settings: gyms.settings }).from(gyms));
      return rows.filter(gym => active(gym, true)).map(({ gymId }) => ({ gymId }));
    },
  };
}
