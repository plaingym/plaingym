// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, canStaff, createTranslator, type Translator } from '@plaingym/shared';
import messages from '../../../../../locales/en/health/status.json' with { type: 'json' };
import { healthResponseSchema, healthTileIds, healthTileSchema, type HealthTile } from '@plaingym/shared/contracts';
import type { HealthTileProvider, StaffProviderContext } from '../../core/interfaces/extensions.js';
import { logWarn } from '../../core/log.js';

export const statusTranslator = createTranslator({ 'health/status': messages });
export const statusMessage = (key: string, values?: Parameters<Translator>[1]) => statusTranslator('health/status:' + key, values);
export function healthProvider(id: HealthTile['id'], read: (context: StaffProviderContext) => Promise<HealthTile>): HealthTileProvider<HealthTile> {
  return { id, permission: 'settings.manage', schema: healthTileSchema, async read(context) {
    if (!canStaff(context.roles, 'settings.manage')) throw new AppError('not_found', 'Health tile not found');
    return read(context);
  } };
}
/**
 * One failed or slow check cannot hide the remaining checks. Provider errors never reach the browser.
 * A tile that has not answered within `tileTimeoutMs` reads "still checking"; its provider keeps running and its
 * late result is discarded. Slow tiles log their ID and duration only.
 */
export function createHealthService(providers: readonly HealthTileProvider<HealthTile>[],
  options: { tileTimeoutMs?: number; slowTileMs?: number; now?: () => number } = {}) {
  const { tileTimeoutMs = 5000, slowTileMs = 2000, now = () => performance.now() } = options;
  const registry = new Map(providers.map((provider) => [provider.id, provider]));
  if (registry.size !== providers.length) throw new Error('Duplicate health provider');
  return { async get(context: StaffProviderContext) {
    if (!canStaff(context.roles, 'settings.manage')) throw new AppError('forbidden', 'Access denied');
    const tiles = await Promise.all(healthTileIds.map(async (id): Promise<HealthTile> => {
      const provider = registry.get(id);
      if (!provider) return { id, status: 'not_configured', checkedAt: null, details: null, message: statusMessage('notSetUp') };
      const started = now();
      // Never rejects: every error becomes the failed-check tile.
      const read = (async (): Promise<HealthTile> => {
        try {
          if (!canStaff(context.roles, provider.permission)) throw new Error('Provider permission denied');
          const tile = healthTileSchema.parse(provider.schema.parse(await provider.read(context)));
          if (tile.id !== id) throw new Error('Provider returned another tile');
          return tile;
        } catch {
          return { id, status: 'unavailable', checkedAt: context.clock.now().toISOString(), details: null, message: statusMessage('checkFailed') };
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), tileTimeoutMs); });
      const tile = await Promise.race([read, limit]);
      clearTimeout(timer);
      if (tile === null) {
        logWarn('health.tile_slow', { tile: id, ms: tileTimeoutMs, timedOut: true });
        return { id, status: 'unavailable', checkedAt: context.clock.now().toISOString(), details: null, message: statusMessage('stillChecking') };
      }
      const ms = Math.round(now() - started);
      if (ms > slowTileMs) logWarn('health.tile_slow', { tile: id, ms, timedOut: false });
      return tile;
    }));
    return healthResponseSchema.parse({ data: { generatedAt: context.clock.now().toISOString(), tiles } });
  } };
}
