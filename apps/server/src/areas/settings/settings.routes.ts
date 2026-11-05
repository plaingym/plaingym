// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { settingsContracts, updateBillingRulesRequestSchema, updateGymSettingsRequestSchema } from '@plaingym/shared/contracts';
import type { MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from '../../core/context.js';
import { route } from '../../core/registry.js';
import { createSettingsService } from './settings.js';
/** The field an issue is about: its path up to the first list index (`address.country`, and `retryDays` for `retryDays.1`). */
const fieldOf = (path: readonly PropertyKey[]) => {
  const names: string[] = [];
  for (const key of path) { if (typeof key !== 'string') break; names.push(key); }
  return names.join('.');
};
/**
 * Runs after authorization and before the shared validator, whose generic error hides field details: a body that fails
 * names every refused field in `details`, with its own code from `codes` or `invalid`. An issue about the body as a
 * whole (no change supplied, a body that isn't an object) names no field and is left to the validator.
 */
const fieldErrors = (schema: typeof updateBillingRulesRequestSchema | typeof updateGymSettingsRequestSchema, codes: Record<string, string>): MiddlewareHandler<RequestEnvironment> =>
  async (c, next) => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error?.issues ?? []) {
      const field = fieldOf(issue.path);
      if (field) details[field] = [codes[field] ?? 'invalid'];
    }
    if (Object.keys(details).length) throw new AppError('invalid_request', 'The request is invalid.', details);
    await next();
  };
const middleware = {
  updateBillingRules: fieldErrors(updateBillingRulesRequestSchema, { retryDays: 'invalid_retry_days' }),
  updateGeneral: fieldErrors(updateGymSettingsRequestSchema, { timezone: 'invalid_timezone' }),
} as const;
const kinds = { updateGeneral: 'general', updateBookingRules: 'booking', updateBillingRules: 'billing', updateCurrency: 'currency', updateDropIn: 'drop_in' } as const;
export function createSettingsRoutes(service = createSettingsService()) {
  const get = settingsContracts.get;
  return [route({ ...get, responses: { 200: { description: 'Gym settings', content: { 'application/json': { schema: get.response } } } } },
    async (c) => c.json({ data: await service.get(c.get('context').gym.gymId) }, 200)),
    ...(['updateGeneral', 'updateBookingRules', 'updateBillingRules', 'updateCurrency', 'updateDropIn'] as const).map((name) => {
      const contract = settingsContracts[name];
      return route({ ...contract,
        ...(name === 'updateBillingRules' || name === 'updateGeneral' ? { middleware: middleware[name] } : {}),
        request: { body: { required: true, content: { 'application/json': { schema: contract.body } } } },
        responses: { 200: { description: 'Updated gym settings', content: { 'application/json': { schema: contract.response } } } },
      }, async (c) => {
        const context = c.get('context');
        if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId)
          throw new AppError('not_found', 'Gym not found');
        const data = await service.update({ gymId: context.gym.gymId, actor: { kind: 'user', userId: context.principal.userId } },
          kinds[name], c.req.valid('json'));
        return c.json({ data }, 200);
      });
    }),
  ];
}
export const routes = createSettingsRoutes();
