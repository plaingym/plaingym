// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { settingsContracts } from '@plaingym/shared/contracts';
import { route, type RouteRegistration } from '../../core/registry.js';
import { goLiveService, type GoLiveService } from './go-live.js';

const t = createTranslator(locales.en ?? {});

/** Tests pass a service; otherwise routes use the runtime composition. */
export function createGoLiveRoutes(service?: GoLiveService): RouteRegistration[] {
  const current = () => service ?? goLiveService();
  const { goLiveChecklist: get, updateGoLive: update } = settingsContracts;
  return [
    route({ ...get, responses: { 200: { description: 'Go-live switches and checklist', content: { 'application/json': { schema: get.response } } } } },
      async (c) => c.json({ data: await current().checklist(c.get('context').gym.gymId) }, 200)),
    route({ ...update,
      request: { body: { required: true, content: { 'application/json': { schema: update.body } } } },
      responses: { 200: { description: 'Updated go-live switches and checklist', content: { 'application/json': { schema: update.response } } } },
    }, async (c) => {
      const context = c.get('context');
      if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId) throw new AppError('not_found', t('settings/go-live:notFound'));
      const data = await current().update({ gymId: context.gym.gymId, actor: { kind: 'user', userId: context.principal.userId } }, c.req.valid('json'));
      return c.json({ data }, 200);
    }),
  ];
}
export const routes: readonly RouteRegistration[] = createGoLiveRoutes();
