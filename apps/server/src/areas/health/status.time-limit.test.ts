// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthTileSchema, type HealthTile } from '@plaingym/shared/contracts';
import { uuidv7 } from '@plaingym/db';
import type { StaffProviderContext } from '../../core/interfaces/extensions.js';
import { TestClock } from '../../core/clock.js';
import { setLogSink } from '../../core/log.js';
import { createHealthService, healthProvider } from './status.js';

const clock = new TestClock('2026-10-22T12:00:00Z');
const context: StaffProviderContext = { gymId: uuidv7(), roles: ['owner'], clock };
const tileOf = (id: HealthTile['id']) => healthTileSchema.parse({ id, status: 'warning', checkedAt: clock.now().toISOString(), details: null, message: 'Answered ' + id });
/** A provider that answers at once (0), after `ms`, or never (null); or fails then. */
const after = (id: HealthTile['id'], ms: number | null, fail = false) => healthProvider(id, () => ms === 0 ? Promise.resolve(tileOf(id))
  : new Promise<HealthTile>((resolve, reject) => {
    if (ms !== null) setTimeout(() => { if (fail) reject(new Error('late failure')); else resolve(tileOf(id)); }, ms);
  }));
const [a, b, c, d] = ['failed_jobs', 'smtp', 'disk', 'version'] as const;
let lines: unknown[], previous: ReturnType<typeof setLogSink>;
beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  lines = []; previous = setLogSink((line) => { lines.push(JSON.parse(line)); });
});
afterEach(() => { setLogSink(previous); vi.useRealTimers(); });
const options = { now: () => Date.now() };

describe('health tile time limit', () => {
  it('answers when the limit is reached, keeps the tiles that answered and logs only the slow ones', async () => {
    const service = createHealthService([after(a, 0), after(b, null), after(c, 3000), after(d, 100)], options);
    let done = false;
    const result = service.get(context).then((response) => { done = true; return response; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    const tiles = new Map((await result).data.tiles.map((tile) => [tile.id, tile]));
    for (const id of [a, c, d]) expect(tiles.get(id)).toMatchObject({ status: 'warning', message: 'Answered ' + id });
    expect(tiles.get(b)).toMatchObject({ status: 'unavailable', details: null, message: 'Still checking. Refresh in a moment.' });
    expect(tiles.get('sms')).toMatchObject({ status: 'not_configured' });
    expect(lines).toEqual([
      { time: expect.any(String), level: 'warn', event: 'health.tile_slow', tile: c, ms: 3000, timedOut: false },
      { time: expect.any(String), level: 'warn', event: 'health.tile_slow', tile: b, ms: 5000, timedOut: true },
    ]);
  });
  it('discards a provider that fails after the limit without an unhandled rejection or another log', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const service = createHealthService([after(a, 0), after(b, 6000, true)], options);
      const result = service.get(context);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await result).data.tiles.find((tile) => tile.id === b)).toMatchObject({ status: 'unavailable', message: 'Still checking. Refresh in a moment.' });
      await vi.advanceTimersByTimeAsync(2000);
      await new Promise((resolve) => { process.nextTick(resolve); });
      expect(unhandled).not.toHaveBeenCalled();
      expect(lines).toEqual([{ time: expect.any(String), level: 'warn', event: 'health.tile_slow', tile: b, ms: 5000, timedOut: true }]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { process.off('unhandledRejection', unhandled); }
  });
  it('shares one read per gym and tile, and starts a new one once it settles', async () => {
    let calls = 0;
    const slow = healthProvider(b, () => { calls++; return new Promise<HealthTile>((resolve) => { setTimeout(() => resolve(tileOf(b)), 7000); }); });
    const service = createHealthService([slow], options);
    const first = service.get(context);
    await vi.advanceTimersByTimeAsync(1000);
    const second = service.get(context);
    expect(calls).toBe(1);
    const other = service.get({ ...context, gymId: uuidv7() });
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);
    const answers = [await first];
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    answers.push(await second, await other);
    for (const response of answers) {
      expect(response.data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Still checking. Refresh in a moment.' });
    }
    // The first read settles at 7 s; the next request starts a new one.
    await vi.advanceTimersByTimeAsync(1000);
    const third = service.get(context);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    await third;
  });
  it('starts a separate read for another tile', async () => {
    let calls = 0;
    const never = (id: HealthTile['id']) => healthProvider(id, () => { calls++; return new Promise<HealthTile>(() => undefined); });
    const service = createHealthService([never(a), never(b)], options);
    const result = service.get(context);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    await result;
  });
  it('leaves no timer running when every tile answers at once', async () => {
    const service = createHealthService([after(a, 0), after(c, 0)], options);
    expect((await service.get(context)).data.tiles.filter((tile) => tile.message.startsWith('Answered '))).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(lines).toEqual([]);
  });
});
