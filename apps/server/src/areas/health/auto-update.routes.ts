// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { autoUpdateContracts, type AutoUpdateSettings as AutoUpdateSettingsResponse } from '@plaingym/shared/contracts';
import { route, type RouteRegistration } from '../../core/registry.js';
import { tenancyMode, type TenancyMode } from '../../core/tenancy.js';
import { createAutoUpdateSettings, type AutoUpdateSetting, type AutoUpdateSettings } from '../settings/auto-update.js';

/**
 * Settings → Updates: the owner's switch for automatic patch updates. The install's nightly timer reads it through
 * `gym-app auto-update check`; the app never touches Docker. An install serving several gyms has no timer, so there
 * the switch reads as unavailable and can't be changed.
 */
export function createAutoUpdateRoutes(options: { settings?: AutoUpdateSettings; tenancy?: TenancyMode } = {}): readonly RouteRegistration[] {
  const settings = options.settings ?? createAutoUpdateSettings();
  const available = () => (options.tenancy ?? tenancyMode()) === 'single';
  const present = (value: AutoUpdateSetting): AutoUpdateSettingsResponse => ({ enabled: value.enabled, available: available(), revision: value.revision });
  const { get, update } = autoUpdateContracts;
  return [
    route({ ...get, responses: { 200: { description: 'The automatic patch update switch', content: { 'application/json': { schema: get.response } } } } }, async (c) => {
      const context = c.get('context');
      if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId) throw new AppError('not_found', 'Gym not found');
      c.header('Cache-Control', 'no-store');
      return c.json({ data: present(await settings.get(context.gym.gymId)) }, 200);
    }),
    route({ ...update,
      request: { body: { required: true, content: { 'application/json': { schema: update.body } } } },
      responses: { 200: { description: 'The saved switch', content: { 'application/json': { schema: update.response } } } },
    }, async (c) => {
      const context = c.get('context');
      if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId) throw new AppError('not_found', 'Gym not found');
      if (!available()) throw new AppError('conflict', 'Automatic updates do not run on an install that serves several gyms');
      const saved = await settings.update({ gymId: context.gym.gymId, actor: { kind: 'user', userId: context.principal.userId } }, c.req.valid('json'));
      c.header('Cache-Control', 'no-store');
      return c.json({ data: present(saved) }, 200);
    }),
  ];
}
export const routes = createAutoUpdateRoutes();
