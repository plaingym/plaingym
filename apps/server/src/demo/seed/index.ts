// SPDX-License-Identifier: AGPL-3.0-only
import type { GymContext } from '../../core/context.js';
import { seeds as mat } from './mat.js';
import { seeds as members } from './members.js';
import { seeds as billing } from './billing.js';
import { seeds as portal } from './portal.js';

export interface SeedStep {
  readonly id: string;
  run(context: GymContext): Promise<void>;
}
export const seeds: readonly SeedStep[] = [...members, ...mat, ...billing, ...portal];
