// SPDX-License-Identifier: AGPL-3.0-only
import type { GymContext } from '../../core/context.js';
import { foundationSeed } from './foundation.js';
import { seeds as mat } from './mat.js';
import { seeds as members } from './members.js';
import { seeds as billing } from './billing.js';
import { seeds as portal } from './portal.js';

export interface SeedStep { readonly id: string; run(context: GymContext): Promise<void>; }
export const seeds: readonly SeedStep[] = [foundationSeed(), ...members, ...mat, ...billing, ...portal];
/** Each step owns its transactions and must tolerate retrying the seed. */
export async function runSeeds(context: GymContext, steps: readonly SeedStep[] = seeds): Promise<void> {
  if (new Set(steps.map((step) => step.id)).size !== steps.length) throw new Error('Duplicate seed step');
  for (const step of steps) await step.run(context);
}
