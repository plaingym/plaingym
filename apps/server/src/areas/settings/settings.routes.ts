// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { settingsContracts, updateBillingRulesRequestSchema } from '@plaingym/shared/contracts';
import type { MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from '../../core/context.js';
import { route } from '../../core/registry.js';
import { createSettingsService } from './settings.js';
// Runs after authorization and before the shared validator, whose generic error hides field details.
const billingFieldErrors: MiddlewareHandler<RequestEnvironment> = async (c, next) => {
  const parsed = updateBillingRulesRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success && parsed.error.issues.some((issue) => issue.path[0] === 'retryDays'))
    throw new AppError('invalid_request', 'The request is invalid.', { retryDays: ['invalid_retry_days'] });
  await next();
};
export function createSettingsRoutes(service = createSettingsService()) {
  const get = settingsContracts.get;
  return [route({ ...get, responses: { 200: { description: 'Gym settings', content: { 'application/json': { schema: get.response } } } } },
    async (c) => c.json({ data: await service.get(c.get('context').gym.gymId) }, 200)),
    ...(['updateGeneral', 'updateBookingRules', 'updateBillingRules', 'updateCurrency'] as const).map((name) => {
      const contract = settingsContracts[name];
      return route({ ...contract,
        ...(name === 'updateBillingRules' ? { middleware: billingFieldErrors } : {}),
        request: { body: { required: true, content: { 'application/json': { schema: contract.body } } } },
        responses: { 200: { description: 'Updated gym settings', content: { 'application/json': { schema: contract.response } } } },
      }, async (c) => {
        const context = c.get('context');
        if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId)
          throw new AppError('not_found', 'Gym not found');
        const data = await service.update({ gymId: context.gym.gymId, actor: { kind: 'user', userId: context.principal.userId } },
          name === 'updateGeneral' ? 'general' : name === 'updateBookingRules' ? 'booking' : name === 'updateBillingRules' ? 'billing' : 'currency', c.req.valid('json'));
        return c.json({ data }, 200);
      });
    }),
  ];
}
export const routes = createSettingsRoutes();
