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
export const healthReadAgeMs = 30_000;
/**
 * One failed or slow check cannot hide the remaining checks. Provider errors never reach the browser.
 * A tile that has not answered within `tileTimeoutMs` reads "still checking"; its provider keeps running and its
 * late result is discarded. Slow tiles log their ID and duration only.
 */
export function createHealthService(providers: readonly HealthTileProvider<HealthTile>[],
  options: { tileTimeoutMs?: number; slowTileMs?: number; maxReadAgeMs?: number; maxReplacedAgeMs?: number; maxUnsettledReads?: number; maxUnsettledAgeMs?: number; maxHungReads?: number; now?: () => number } = {}) {
  const { tileTimeoutMs = 5000, slowTileMs = 2000, maxReadAgeMs = healthReadAgeMs, maxReplacedAgeMs = 4 * maxReadAgeMs, maxUnsettledReads = 3, maxUnsettledAgeMs = 30 * 60_000, maxHungReads = 12, now = () => performance.now() } = options;
  const registry = new Map(providers.map((provider) => [provider.id, provider]));
  if (registry.size !== providers.length) throw new Error('Duplicate health provider');
  if (maxHungReads < maxUnsettledReads) throw new Error('maxHungReads must be at least maxUnsettledReads');
  type Entry = { read: Promise<HealthTile>; startedAt: number; loggedSlow: boolean };
  const inFlight = new Map<string, Entry>();
  const replaced = new Map<string, Entry>();
  const unsettled = new Map<string, Set<Entry>>();
  // Keys whose wait at the maxHungReads cap is already logged.
  const hungLogged = new Set<string>();
  // A read stops counting toward maxUnsettledReads once it is maxUnsettledAgeMs old (it keeps running), so a tile
  // whose reads hang for good is checked again, until maxHungReads reads of any age are unsettled.
  const youngUnsettled = (key: string) => {
    let count = 0;
    for (const entry of unsettled.get(key) ?? []) if (now() - entry.startedAt < maxUnsettledAgeMs) count++;
    return count;
  };
  return { async get(context: StaffProviderContext) {
    if (!canStaff(context.roles, 'settings.manage')) throw new AppError('forbidden', 'Access denied');
    const tiles = await Promise.all(healthTileIds.map(async (id): Promise<HealthTile> => {
      const provider = registry.get(id);
      if (!provider) return { id, status: 'not_configured', checkedAt: null, details: null, message: statusMessage('notSetUp') };
      const failed = (): HealthTile => ({ id, status: 'unavailable', checkedAt: context.clock.now().toISOString(), details: null, message: statusMessage('checkFailed') });
      // Never rejects: every error becomes the failed-check tile. A request that finds a read in flight for the
      // same gym and tile waits for it instead of starting another unless it is older than maxReadAgeMs, either
      // no replaced read is still pending or the running read has reached maxReplacedAgeMs (replacing the tracked
      // replaced read with the running one), fewer than maxUnsettledReads reads younger than maxUnsettledAgeMs are still unsettled for it,
      // and fewer than maxHungReads reads of any age are; the permission is still checked per request.
      let entry: Entry;
      if (!canStaff(context.roles, provider.permission)) {
        entry = { read: Promise.resolve(failed()), startedAt: now(), loggedSlow: false };
      } else {
        const key = context.gymId + ':' + id;
        const running = inFlight.get(key);
        const age = running ? now() - running.startedAt : 0;
        const shared = age <= maxReadAgeMs || (replaced.has(key) && age < maxReplacedAgeMs);
        const unsettledCount = unsettled.get(key)?.size ?? 0;
        const capped = unsettledCount >= maxHungReads;
        if (running && (shared || capped || youngUnsettled(key) >= maxUnsettledReads)) {
          if (!shared && capped && !hungLogged.has(key)) {
            hungLogged.add(key);
            logWarn('health.tile_hung', { tile: id, unsettled: unsettledCount });
          }
          entry = running;
        } else {
          if (running) {
            replaced.set(key, running);
            void running.read.finally(() => { if (replaced.get(key) === running) replaced.delete(key); });
          }
          const startedAt = now();
          const fresh: Entry = {
            read: (async (): Promise<HealthTile> => {
              try {
                const tile = healthTileSchema.parse(provider.schema.parse(await provider.read(context)));
                if (tile.id !== id) throw new Error('Provider returned another tile');
                return tile;
              } catch {
                return failed();
              }
            })(),
            startedAt,
            loggedSlow: false,
          };
          inFlight.set(key, fresh);
          const pending = unsettled.get(key) ?? new Set<Entry>();
          pending.add(fresh);
          unsettled.set(key, pending);
          void fresh.read.finally(() => {
            const remaining = unsettled.get(key);
            remaining?.delete(fresh);
            if (remaining?.size === 0) unsettled.delete(key);
            if ((remaining?.size ?? 0) < maxHungReads) hungLogged.delete(key);
            if (inFlight.get(key) === fresh) inFlight.delete(key);
          });
          entry = fresh;
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), tileTimeoutMs); });
      const tile = await Promise.race([entry.read, limit]);
      clearTimeout(timer);
      if (tile === null) {
        logWarn('health.tile_slow', { tile: id, ms: tileTimeoutMs, timedOut: true });
        return { id, status: 'unavailable', checkedAt: context.clock.now().toISOString(), details: null, message: statusMessage('stillChecking') };
      }
      const ms = Math.round(now() - entry.startedAt);
      if (ms > slowTileMs && !entry.loggedSlow) {
        entry.loggedSlow = true;
        logWarn('health.tile_slow', { tile: id, ms, timedOut: false });
      }
      return tile;
    }));
    return healthResponseSchema.parse({ data: { generatedAt: context.clock.now().toISOString(), tiles } });
  } };
}
