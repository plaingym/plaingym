// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { settingsContracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { createSettingsService } from './settings.js';
export function createSettingsRoutes(service = createSettingsService()) {
  const get = settingsContracts.get;
  return [route({ ...get, responses: { 200: { description: 'Gym settings', content: { 'application/json': { schema: get.response } } } } },
    async (c) => c.json({ data: await service.get(c.get('context').gym.gymId) }, 200)),
    ...(['updateGeneral', 'updateBookingRules', 'updateCurrency'] as const).map((name) => {
      const contract = settingsContracts[name];
      return route({ ...contract,
        request: { body: { required: true, content: { 'application/json': { schema: contract.body } } } },
        responses: { 200: { description: 'Updated gym settings', content: { 'application/json': { schema: contract.response } } } },
      }, async (c) => {
        const context = c.get('context');
        if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId)
          throw new AppError('not_found', 'Gym not found');
        const data = await service.update({ gymId: context.gym.gymId, actor: { kind: 'user', userId: context.principal.userId } },
          name === 'updateGeneral' ? 'general' : name === 'updateBookingRules' ? 'booking' : 'currency', c.req.valid('json'));
        return c.json({ data }, 200);
      });
    }),
  ];
}
export const routes = createSettingsRoutes();
