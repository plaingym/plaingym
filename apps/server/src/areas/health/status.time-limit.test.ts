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
    // At 275 s (the third read is 120 s old), three reads are already unsettled, so calls stay 3.
    await vi.advanceTimersByTimeAsync(84_000);
    expect(Date.now()).toBe(275_000);
    const r275 = service.get(context);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await r275).data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Still checking. Refresh in a moment.' });
    // Continuing with a refresh every 31 s until the first read is 30 minutes old never exceeds three unsettled calls.
    for (let next = 306_000; next < 1_800_000; next += 31_000) {
      await vi.advanceTimersByTimeAsync(next - Date.now());
      const response = service.get(context);
      expect(calls).toBe(3);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await response).data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Still checking. Refresh in a moment.' });
    }
  });
  it('stops counting an unsettled read toward the cap once it is 30 minutes old, so a hung tile is read again', async () => {
    let calls = 0;
    const provider = healthProvider(b, () => {
      calls++;
      return calls <= 3 ? new Promise<HealthTile>(() => undefined) : Promise.resolve(tileOf(b));
    });
    const service = createHealthService([provider], options);
    for (const at of [0, 31_000, 155_000]) {
      await vi.advanceTimersByTimeAsync(at - Date.now());
      const response = service.get(context);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await response).data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Still checking. Refresh in a moment.' });
    }
    expect(calls).toBe(3);
    // A minute after the third read started, all three are unsettled and young: the refresh waits on the newest.
    await vi.advanceTimersByTimeAsync(215_000 - Date.now());
    const r215 = service.get(context);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await r215).data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Still checking. Refresh in a moment.' });
    // Just before the first read is 30 minutes old it still counts.
    await vi.advanceTimersByTimeAsync(1_799_999 - Date.now());
    const before = service.get(context);
    expect(calls).toBe(3);
    // At 30 minutes and 1 ms after the first read, it no longer counts: a fourth read starts and serves the tile.
    await vi.advanceTimersByTimeAsync(2);
    expect(Date.now()).toBe(1_800_001);
    const late = service.get(context);
    expect(calls).toBe(4);
    expect((await late).data.tiles.find((tile) => tile.id === b)).toMatchObject({ status: 'warning', message: 'Answered smtp' });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await before).data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Still checking. Refresh in a moment.' });
  });
  it('starts a new read once one of three never-settling reads settles at five minutes', async () => {
    let calls = 0;
    let resolveSecond!: (tile: HealthTile) => void;
    const provider = healthProvider(b, () => {
      calls++;
      return new Promise<HealthTile>((resolve) => {
        if (calls === 2) resolveSecond = resolve;
      });
    });
    const service = createHealthService([provider], options);
    for (const at of [0, 31_000, 155_000]) {
      await vi.advanceTimersByTimeAsync(at - Date.now());
      const response = service.get(context);
      await vi.advanceTimersByTimeAsync(5000);
      await response;
    }
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(300_000 - Date.now());
    const r300 = service.get(context);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    await r300;
    resolveSecond(tileOf(b));
    await vi.advanceTimersByTimeAsync(1000);
    const next = service.get(context);
    expect(calls).toBe(4);
    await vi.advanceTimersByTimeAsync(5000);
    await next;
  });
  it('starts a fourth read past two minutes once one of three unsettled reads settles, and shares it for 30 s', async () => {
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
    await vi.advanceTimersByTimeAsync(26_000); // 31 s: starts read 2
    const r31 = service.get(context);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    await r31;
    await vi.advanceTimersByTimeAsync(119_000); // 155 s: starts read 3
    const r155 = service.get(context);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(5000); // 160 s
    await r155;
    // Read 1 settles, dropping unsettled from 3 to 2; the next get past 120 s from read 3 starts read 4.
    resolveFirst(tileOf(b));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(116_000); // 276 s (read 3 is 121 s old)
    const r276 = service.get(context);
    expect(calls).toBe(4);
    await vi.advanceTimersByTimeAsync(5000); // 281 s
    await r276;
    await vi.advanceTimersByTimeAsync(10_000); // 291 s (read 4 is 15 s old, within 30 s)
    const r291 = service.get(context);
    expect(calls).toBe(4);
    await vi.advanceTimersByTimeAsync(5000);
    await r291;
  });
  it('honors a lower maxUnsettledReads cap when a provider never settles', async () => {
    let calls = 0;
    const never = healthProvider(b, () => { calls++; return new Promise<HealthTile>(() => undefined); });
    const service = createHealthService([never], { ...options, maxUnsettledReads: 1 });
    const r0 = service.get(context);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    await r0;
    await vi.advanceTimersByTimeAsync(26_000); // 31 s
    const r31 = service.get(context);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    await r31;
    await vi.advanceTimersByTimeAsync(119_000); // 155 s
    const r155 = service.get(context);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    await r155;
    await vi.advanceTimersByTimeAsync(440_000); // 600 s
    const r600 = service.get(context);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    await r600;
  });
  /** One request a minute from the current fake time up to `until`; every one answers "still checking" within the limit. */
  async function refreshEveryMinute(service: ReturnType<typeof createHealthService>, until: number) {
    while (Date.now() < until) {
      let done = false;
      const response = service.get(context).then((value) => { done = true; return value; });
      await vi.advanceTimersByTimeAsync(5000);
      expect(done).toBe(true);
      expect((await response).data.tiles.find((tile) => tile.id === b)).toMatchObject({ message: 'Still checking. Refresh in a moment.' });
      await vi.advanceTimersByTimeAsync(55_000);
    }
  }
  const hungLines = () => (lines as Array<{ event: string }>).filter((line) => line.event === 'health.tile_hung');
  const eightHours = 8 * 60 * 60_000;
  it('keeps at most 12 unsettled reads over 8 hours and logs the cap once', async () => {
    let calls = 0;
    const never = healthProvider(b, () => { calls++; return new Promise<HealthTile>(() => undefined); });
    await refreshEveryMinute(createHealthService([never], options), eightHours);
    expect(calls).toBe(12);
    expect(hungLines()).toEqual([{ time: expect.any(String), level: 'warn', event: 'health.tile_hung', tile: b, unsettled: 12 }]);
  });
  it('starts one new read once a read settles at the cap, and logs the next cap again', async () => {
    let calls = 0;
    const resolvers: Array<(tile: HealthTile) => void> = [];
    const provider = healthProvider(b, () => { calls++; return new Promise<HealthTile>((resolve) => { resolvers.push(resolve); }); });
    const service = createHealthService([provider], options);
    await refreshEveryMinute(service, eightHours);
    expect(calls).toBe(12);
    expect(hungLines()).toHaveLength(1);
    // An old read settles: the newest is hours old, so the next refresh starts exactly one more.
    resolvers[0]!(tileOf(b));
    await vi.advanceTimersByTimeAsync(0);
    await refreshEveryMinute(service, eightHours + 60_000);
    expect(calls).toBe(13);
    await refreshEveryMinute(service, eightHours + 60 * 60_000);
    expect(calls).toBe(13);
    expect(hungLines()).toHaveLength(2);
  });
  it('honors a lower maxHungReads cap', async () => {
    let calls = 0;
    const never = healthProvider(b, () => { calls++; return new Promise<HealthTile>(() => undefined); });
    await refreshEveryMinute(createHealthService([never], { ...options, maxUnsettledReads: 3, maxHungReads: 4 }), eightHours);
    expect(calls).toBe(4);
    expect(hungLines()).toHaveLength(1);
  });
  it("starts another gym's own read while one gym is at the cap", async () => {
    let calls = 0;
    const never = healthProvider(b, () => { calls++; return new Promise<HealthTile>(() => undefined); });
    const service = createHealthService([never], { ...options, maxUnsettledReads: 1, maxHungReads: 1 });
    await refreshEveryMinute(service, 5 * 60_000);
    expect(calls).toBe(1);
    expect(hungLines()).toHaveLength(1);
    const other = service.get({ ...context, gymId: uuidv7() });
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    await other;
  });
  it('refuses a maxHungReads below maxUnsettledReads', () => {
    expect(() => createHealthService([], { maxHungReads: 2 })).toThrow('maxHungReads');
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
