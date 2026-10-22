// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, canStaff, createTranslator, type Translator } from '@plaingym/shared';
import messages from '../../../../../locales/en/health/status.json' with { type: 'json' };
import { healthResponseSchema, healthTileIds, healthTileSchema, type HealthTile } from '@plaingym/shared/contracts';
import type { HealthTileProvider, StaffProviderContext } from '../../core/interfaces/extensions.js';

export const statusTranslator = createTranslator({ 'health/status': messages });
export const statusMessage = (key: string, values?: Parameters<Translator>[1]) => statusTranslator('health/status:' + key, values);
export function healthProvider(id: HealthTile['id'], read: (context: StaffProviderContext) => Promise<HealthTile>): HealthTileProvider<HealthTile> {
  return { id, permission: 'settings.manage', schema: healthTileSchema, async read(context) {
    if (!canStaff(context.roles, 'settings.manage')) throw new AppError('not_found', 'Health tile not found');
    return read(context);
  } };
}
/** One failed check cannot hide the remaining checks. Provider errors never reach the browser. */
export function createHealthService(providers: readonly HealthTileProvider<HealthTile>[]) {
  const registry = new Map(providers.map((provider) => [provider.id, provider]));
  if (registry.size !== providers.length) throw new Error('Duplicate health provider');
  return { async get(context: StaffProviderContext) {
    if (!canStaff(context.roles, 'settings.manage')) throw new AppError('forbidden', 'Access denied');
    const tiles = await Promise.all(healthTileIds.map(async (id): Promise<HealthTile> => {
      const provider = registry.get(id);
      if (!provider) return { id, status: 'not_configured', checkedAt: null, details: null, message: statusMessage('notSetUp') };
      try {
        if (!canStaff(context.roles, provider.permission)) throw new Error('Provider permission denied');
        const tile = healthTileSchema.parse(provider.schema.parse(await provider.read(context)));
        if (tile.id !== id) throw new Error('Provider returned another tile');
        return tile;
      } catch {
        return { id, status: 'unavailable', checkedAt: context.clock.now().toISOString(), details: null, message: statusMessage('checkFailed') };
      }
    }));
    return healthResponseSchema.parse({ data: { generatedAt: context.clock.now().toISOString(), tiles } });
  } };
}
