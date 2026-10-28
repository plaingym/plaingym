// SPDX-License-Identifier: AGPL-3.0-only
import { forGym } from '@plaingym/db';
import type { GymContext } from '../../core/context.js';
import { clock as defaultClock } from '../../core/clock.js';
import { logError } from '../../core/log.js';
import { foundationSeed } from './foundation.js';
import { matSeed } from './mat.js';
import { membersSeed } from './members.js';
import { billingSeed } from './billing.js';
import type { BillingSeedProvider } from './billing-payments.js';
import { seeds as portal } from './portal.js';
import { waiversSeed } from './waivers.js';
import type { WaiverOptions } from '../../areas/waivers/waivers.js';
import { createRuntimeUploads } from '../../infra/storage/runtime.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { demoBootCheck } from '../config.js';
import { createDemoPayments } from '../payments.js';

export interface SeedStep { readonly id: string; run(context: GymContext): Promise<void>; }
type SeedOptions = WaiverOptions & Pick<NonNullable<Parameters<typeof membersSeed>[0]>, 'pinSecret'> & {
  billingPaymentsFor?: (gymId: string) => Promise<BillingSeedProvider>;
  log?: (line: string) => void;
};
export function createSeeds(options: SeedOptions): readonly SeedStep[] {
  const billing = options.billingPaymentsFor ? billingSeed({ scope: options.scope ?? forGym,
    clock: options.clock ?? defaultClock, paymentsFor: options.billingPaymentsFor }) : {
    id: 'billing', async run() {
      (options.log ?? (line => process.stderr.write(line + '\n')))('Demo billing seed skipped: DEMO_STRIPE_TEST_KEY is not configured; sandbox billing is not configured.');
    },
  };
  return [foundationSeed(options), membersSeed(options), billing, waiversSeed(options), matSeed(options), ...portal];
}
/** Each step owns its transactions and must tolerate retrying the seed. */
export async function runSeeds(context: GymContext, steps?: readonly SeedStep[], options: Partial<SeedOptions> & { env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  if (!steps) {
    const env = options.env ?? process.env;
    const config = demoBootCheck(env);
    const payments = createDemoPayments({ config, ...options });
    // This resolver exists only for a seed invocation, is closed afterwards and
    // never escapes into an HTTP feature. Both sandbox creation and the CLI use it.
    const uploads = options.uploadsFor ? undefined : createRuntimeUploads(env, parseEncryptionKey(env.APP_ENCRYPTION_KEY ?? ''), async () => 'http://localhost');
    const { billingPaymentsFor, ...seedOptions } = options;
    try { await runSeeds(context, createSeeds({ ...seedOptions, uploadsFor: options.uploadsFor ?? uploads!.forSeed,
      ...(config.stripe ? { billingPaymentsFor: billingPaymentsFor ?? payments.forSeed } : {}) })); }
    finally { uploads?.close(); }
    return;
  }
  if (new Set(steps.map((step) => step.id)).size !== steps.length) throw new Error('Duplicate seed step');
  for (const step of steps) {
    try { await step.run(context); }
    catch (error) {
      logError('demo.seed_failed', { gymId: context.gymId, step: step.id }, error);
      throw error;
    }
  }
}
