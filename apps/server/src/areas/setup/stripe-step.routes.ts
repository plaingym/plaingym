// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { setupContracts } from '@plaingym/shared/contracts';
import { route, type RouteRegistration } from '../../core/registry.js';
import type { createStripeStep } from './stripe-step.js';

/** Replace the skip-only setup route at integration; never mount both registrations. */
export function createStripeStepRoutes(step: ReturnType<typeof createStripeStep>): readonly RouteRegistration[] {
  const contract = setupContracts.stripe;
  return [route({ ...contract, request: { body: { required: true, content: { 'application/json': { schema: contract.body } } } },
    responses: { 200: { description: 'Stripe configuration', content: { 'application/json': { schema: contract.response } } } } }, async (c) => {
    const { gym, principal } = c.get('context');
    if (principal.kind !== 'staff' || principal.gymId !== gym.gymId) throw new AppError('not_found', 'Gym not found');
    if (!principal.roles.includes('owner')) throw new AppError('forbidden', 'Owner access required');
    return c.json({ data: await step.configure({ gymId: gym.gymId, actor: { kind: 'user', userId: principal.userId } }, c.req.valid('json')) }, 200);
  })];
}

export const routes: readonly RouteRegistration[] = [];
