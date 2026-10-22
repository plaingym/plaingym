// SPDX-License-Identifier: AGPL-3.0-only
import type { Id } from '@plaingym/shared/contracts';
import { TestClock } from '../clock.js';
import type { MutationContext } from './common.js';
export const id = (n: number): Id => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
export const gym = id(1);
export const otherGym = id(2);
export const household = id(3);
export const member = id(4);
export const sibling = id(5);
export const plan = id(6);
export const clock = () => new TestClock('2026-10-21T12:00:00Z');
export const mutation: MutationContext = { gymId: gym, actor: { kind: 'system' } };
