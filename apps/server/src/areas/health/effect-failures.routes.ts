// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { healthContracts } from '@plaingym/shared/contracts';
import { route, type RouteRegistration } from '../../core/registry.js';
import type { TransitionEffects } from '../billing/transitions/effects.js';

type EffectFailures = Pick<TransitionEffects, 'exhaustedEffects' | 'retryEffect' | 'dismissEffect'>;
let configured: EffectFailures | undefined;
export function configureEffectFailures(effects: EffectFailures) { configured = effects; }
export function createEffectFailureRoutes(effects?: EffectFailures): readonly RouteRegistration[] {
  const read = () => {
    const found = effects ?? configured;
    if (!found) throw new AppError('unavailable', 'Invoice effect recovery is not available');
    return found;
  };
  const list = healthContracts.listEffectFailures;
  return [
    route({ ...list, responses: { 200: { description: 'Exhausted invoice effects', content: { 'application/json': { schema: list.response } } } } }, async c => {
      const context = c.get('context'), principal = context.principal;
      if (principal.kind !== 'staff' || principal.gymId !== context.gym.gymId) throw new AppError('not_found', 'Gym not found');
      const data = await read().exhaustedEffects(context.gym.gymId);
      c.header('Cache-Control', 'no-store');
      return c.json({ data }, 200);
    }),
    ...(['retryEffect', 'dismissEffect'] as const).map(action => {
      const contract = healthContracts[action];
      return route({ ...contract, request: { body: { required: true, content: { 'application/json': { schema: contract.body } } } },
        responses: { 200: { description: 'Invoice effect action', content: { 'application/json': { schema: contract.response } } } } }, async c => {
        const context = c.get('context'), principal = context.principal;
        if (principal.kind !== 'staff' || principal.gymId !== context.gym.gymId) throw new AppError('not_found', 'Gym not found');
        const data = await read()[action]({ gymId: context.gym.gymId, actor: { kind: 'user', userId: principal.userId } }, c.req.valid('json').effectId);
        c.header('Cache-Control', 'no-store');
        return c.json({ data }, 200);
      });
    }),
  ];
}
export const routes = createEffectFailureRoutes();
