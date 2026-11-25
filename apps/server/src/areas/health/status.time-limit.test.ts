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
  it('replaces an in-flight read older than maxReadAgeMs and ignores the old read when it settles late', async () => {
    let calls = 0;
    let resolveFirst!: (tile: HealthTile) => void;
    let resolveSecond!: (tile: HealthTile) => void;
    const provider = healthProvider(b, () => {
      calls++;
      return new Promise<HealthTile>((resolve) => {
        if (calls === 1) resolveFirst = resolve;
        else if (calls === 2) resolveSecond = resolve;
      });
    });
    const service = createHealthService([provider], options);
    const first = service.get(context);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await first).data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Still checking. Refresh in a moment.' });
    // At 10 s (younger than 30 s), a refresh still shares the first read.
    await vi.advanceTimersByTimeAsync(5000);
    const second = service.get(context);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    await second;
    // At 31 s (older than 30 s), a refresh starts a second read.
    await vi.advanceTimersByTimeAsync(16_000);
    const third = service.get(context);
    expect(calls).toBe(2);
    // First read settles late after the second started: it must not delete the second's entry.
    resolveFirst(tileOf(b));
    await Promise.resolve();
    const fourth = service.get(context);
    expect(calls).toBe(2);
    resolveSecond(healthTileSchema.parse({ id: b, status: 'warning', checkedAt: clock.now().toISOString(), details: null, message: 'Second read' }));
    const [thirdResult, fourthResult] = await Promise.all([third, fourth]);
    expect(thirdResult.data.tiles.find((tile) => tile.id === b)).toMatchObject({ status: 'warning', message: 'Second read' });
    expect(fourthResult.data.tiles.find((tile) => tile.id === b)).toMatchObject({ status: 'warning', message: 'Second read' });
  });
  it('logs health.tile_slow once per shared read from its start and still logs timedOut: true on timeout', async () => {
    const slow = healthProvider(b, () => new Promise<HealthTile>((resolve) => { setTimeout(() => resolve(tileOf(b)), 3000); }));
    const service = createHealthService([slow, after(c, null)], options);
    const first = service.get(context);
    await vi.advanceTimersByTimeAsync(2500);
    const second = service.get(context);
    await vi.advanceTimersByTimeAsync(2500);
    expect((await first).data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Answered ' + b });
    await vi.advanceTimersByTimeAsync(2500);
    expect((await second).data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Answered ' + b });
    expect(lines).toEqual([
      { time: expect.any(String), level: 'warn', event: 'health.tile_slow', tile: b, ms: 3000, timedOut: false },
      { time: expect.any(String), level: 'warn', event: 'health.tile_slow', tile: c, ms: 5000, timedOut: true },
      { time: expect.any(String), level: 'warn', event: 'health.tile_slow', tile: c, ms: 5000, timedOut: true },
    ]);
  });
  it('retries a provider that never settles only once the newest read reaches two minutes', async () => {
    let calls = 0;
    const never = healthProvider(b, () => { calls++; return new Promise<HealthTile>(() => undefined); });
    const service = createHealthService([never], options);
    const r0 = service.get(context);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await r0).data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Still checking. Refresh in a moment.' });
    await vi.advanceTimersByTimeAsync(26_000);
    const r31 = service.get(context);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await r31).data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Still checking. Refresh in a moment.' });
    for (const [stepMs, request] of [[26_000, 62], [26_000, 93], [26_000, 124]] as const) {
      await vi.advanceTimersByTimeAsync(stepMs);
      expect(Date.now()).toBe(request * 1000);
      const response = service.get(context);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await response).data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Still checking. Refresh in a moment.' });
    }
    expect(calls).toBe(2);
    // At 155 s (the second read is 124 s old, past the 120 s ceiling), a third read starts.
    await vi.advanceTimersByTimeAsync(26_000);
    expect(Date.now()).toBe(155_000);
    const r155 = service.get(context);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await r155).data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Still checking. Refresh in a moment.' });
    // At 186 s (the third read is 31 s old), the second read is still pending, so calls stay 3.
    await vi.advanceTimersByTimeAsync(26_000);
    expect(Date.now()).toBe(186_000);
    const r186 = service.get(context);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await r186).data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Still checking. Refresh in a moment.' });
    // At 275 s (the third read is 120 s old), a fourth read starts.
    await vi.advanceTimersByTimeAsync(84_000);
    expect(Date.now()).toBe(275_000);
    const r275 = service.get(context);
    expect(calls).toBe(4);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await r275).data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Still checking. Refresh in a moment.' });
  });
  it('starts a new read once the replaced read settles while keeping at most two pending', async () => {
    let calls = 0;
    let resolveFirst!: (tile: HealthTile) => void;
    const provider = healthProvider(b, () => {
      calls++;
      return new Promise<HealthTile>((resolve) => {
        if (calls === 1) resolveFirst = resolve;
      });
    });
    const service = createHealthService([provider], options);
    const r0 = service.get(context);
    await vi.advanceTimersByTimeAsync(5000);
    await r0;
    await vi.advanceTimersByTimeAsync(26_000);
    const r31 = service.get(context);
    await vi.advanceTimersByTimeAsync(5000);
    await r31;
    await vi.advanceTimersByTimeAsync(26_000); // 62 s
    const r62 = service.get(context);
    await vi.advanceTimersByTimeAsync(5000);
    await r62;
    await vi.advanceTimersByTimeAsync(26_000); // 93 s
    const r93 = service.get(context);
    expect(calls).toBe(2);
    resolveFirst(tileOf(b));
    await vi.advanceTimersByTimeAsync(1000); // 94 s; also flushes microtasks for replaced.delete
    const r94 = service.get(context);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(31_000); // 125 s: second and third are both still pending
    const r125 = service.get(context);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([r93, r94, r125]);
  });
  it('scales maxReplacedAgeMs from maxReadAgeMs when two reads hang', async () => {
    let calls = 0;
    const never = healthProvider(b, () => { calls++; return new Promise<HealthTile>(() => undefined); });
    const service = createHealthService([never], { ...options, maxReadAgeMs: 10_000 });
    const r0 = service.get(context);
    await vi.advanceTimersByTimeAsync(5000);
    await r0;
    await vi.advanceTimersByTimeAsync(6000); // 11 s: > 10 s, starts second read
    expect(Date.now()).toBe(11_000);
    const r11 = service.get(context);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    await r11;
    await vi.advanceTimersByTimeAsync(34_000); // 50 s: second read is 39 s old (< 40 s)
    expect(Date.now()).toBe(50_000);
    const r50 = service.get(context);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000); // 51 s: ceiling 40 s from the second read at 11 s
    expect(Date.now()).toBe(51_000);
    const r51 = service.get(context);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([r50, r51]);
  });
  it('ignores an older replaced read settling after a third read moved it out of tracking', async () => {
    let calls = 0;
    const resolvers: Array<(tile: HealthTile) => void> = [];
    const provider = healthProvider(b, () => {
      calls++;
      return new Promise<HealthTile>((resolve) => { resolvers.push(resolve); });
    });
    const service = createHealthService([provider], options);
    const r0 = service.get(context);
    await vi.advanceTimersByTimeAsync(5000);
    await r0;
    await vi.advanceTimersByTimeAsync(26_000); // 31 s: starts read 2, tracks read 1 as replaced
    const r31 = service.get(context);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    await r31;
    await vi.advanceTimersByTimeAsync(119_000); // 155 s: starts read 3, tracks read 2 as replaced
    const r155 = service.get(context);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    await r155;
    // Read 1 settles late at 160 s: must not clear read 2 from replaced tracking.
    resolvers[0]!(tileOf(b));
    await vi.advanceTimersByTimeAsync(26_000); // 186 s: read 3 is 31 s old, read 2 is still tracked
    const r186 = service.get(context);
    expect(calls).toBe(3);
    // Read 2 settles at 186 s: clears replaced tracking so the next refresh starts read 4.
    resolvers[1]!(tileOf(b));
    await vi.advanceTimersByTimeAsync(5000); // 191 s
    const r191 = service.get(context);
    expect(calls).toBe(4);
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([r186, r191]);
  });
});
