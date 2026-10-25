// SPDX-License-Identifier: AGPL-3.0-only
import type { GymContext } from '../../core/context.js';
import { foundationSeed } from './foundation.js';
import { matSeed } from './mat.js';
import { membersSeed } from './members.js';
import { seeds as billing } from './billing.js';
import { seeds as portal } from './portal.js';
import { waiversSeed } from './waivers.js';
import type { WaiverOptions } from '../../areas/waivers/waivers.js';
import { createRuntimeUploads } from '../../infra/storage/runtime.js';
import { parseEncryptionKey } from '../../core/secrets.js';

export interface SeedStep { readonly id: string; run(context: GymContext): Promise<void>; }
export function createSeeds(options: WaiverOptions & Pick<NonNullable<Parameters<typeof membersSeed>[0]>, 'pinSecret'>): readonly SeedStep[] {
  return [foundationSeed(options), membersSeed(options), waiversSeed(options), matSeed(options), ...billing, ...portal];
}
/** Each step owns its transactions and must tolerate retrying the seed. */
export async function runSeeds(context: GymContext, steps?: readonly SeedStep[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  if (!steps) {
    const env = options.env ?? process.env;
    // This resolver exists only for a seed invocation, is closed afterwards and
    // never escapes into an HTTP feature. Both sandbox creation and the CLI use it.
    const uploads = createRuntimeUploads(env, parseEncryptionKey(env.APP_ENCRYPTION_KEY ?? ''), async () => 'http://localhost');
    try { await runSeeds(context, createSeeds({ uploadsFor: uploads.forSeed })); }
    finally { uploads.close(); }
    return;
  }
  if (new Set(steps.map((step) => step.id)).size !== steps.length) throw new Error('Duplicate seed step');
  for (const step of steps) await step.run(context);
}
