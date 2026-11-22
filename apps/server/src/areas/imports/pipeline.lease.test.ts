// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import type { ImportPlanRequest, ImportPreviewState } from '@plaingym/shared/contracts';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { afterEach, expect, it, vi } from 'vitest';
import { TestClock } from '../../core/clock.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { MapperRegistry, type CsvMapper } from './mappers/registry.js';
import { PreviewBudget, PREVIEW_CLEANUP_MS, PREVIEW_LEASE_INTERVAL_MS, PREVIEW_LEASE_MS, PREVIEW_TIMEOUT_MS } from './pipeline.budget.js';
import { PipelineStore } from './pipeline.store.js';
import { createImportPipeline, IMPORT_CHUNK_SIZE, PREVIEW_FILE_ROWS } from './pipeline.js';

const database = useTestDatabase(), factory = createFactories(database);
const page = { limit: 10, offset: 0 };
const failureMessage = 'This mapping needs a name.';
const timedOut = expect.stringContaining('took too long');

afterEach(() => vi.restoreAllMocks());

function analysisGate() {
  return { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
}

async function fixture(previewBudget = new PreviewBudget(), previewTimeoutMs = PREVIEW_TIMEOUT_MS, rowCount = 1) {
  const gymId = uuidv7(), actor = { gymId, actor: { kind: 'system' } } as const;
  await factory('gyms', gymId);
  const clock = new TestClock('2099-10-24T00:00:00Z'), storage = new FakeUploads(gymId, clock);
  const uploadsFor = async () => storage;
  const options = { uploadsFor, jobs: new FakeJobs(clock), scope: database.forGym, clock };
  const gate = analysisGate();
  function writer(fail = false, analysis = gate, gateChunk = 1) {
    let chunks = 0;
    const mapper: CsvMapper = {
      id: 'people', available: true,
      async analyze(_tx, rows) {
        if (++chunks === gateChunk) {
          analysis.entered.resolve();
          await analysis.release.promise;
        }
        if (fail) throw new AppError('invalid_request', failureMessage);
        return rows.map(row => ({ rowNumber: row.rowNumber, values: { name: 'Pat' }, action: 'create', duplicateIds: [], issues: [] }));
      },
      async commit() { return 0; },
    };
    return createImportPipeline({ ...options, previewBudget, previewTimeoutMs, mappers: new MapperRegistry([mapper]) });
  }
  const upload = await writer().upload(actor, new File(['Name\n' + 'Pat\n'.repeat(rowCount)], 'people.csv'));
  const reader = (time = clock) => createImportPipeline({ ...options, clock: time, previewBudget: new PreviewBudget() });
  const plan: ImportPlanRequest = { uploadId: upload.id, mapper: 'people', duplicatePolicy: 'error',
    mapping: [{ sourceColumn: 'Name', targetField: 'firstName' }] };
  const store = new PipelineStore(uploadsFor);
  return { actor, clock, storage, store, reader, writer, upload, plan, ...gate };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Pipeline = ReturnType<typeof createImportPipeline>;

function pendingId(state: ImportPreviewState): string {
  if (state.status !== 'queued' && state.status !== 'computing') throw new Error('Expected a pending ticket');
  return state.id;
}

function ticketPrefix(f: Fixture, id: string): string {
  return f.store.key(f.actor.gymId, 'uploads', f.upload.id, `preview/requests/${id}`);
}

function poll(f: Fixture, id: string, pipeline: Pipeline) {
  return pipeline.getPreview(f.actor.gymId, f.upload.id, id, page);
}

function watchHeartbeats(clock: TestClock) {
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const renewals = vi.spyOn(PipelineStore.prototype, 'renewLease');
  // Fire only the heartbeat under test, leaving the deadline and database timers on real time.
  const scheduled = (milliseconds = PREVIEW_LEASE_INTERVAL_MS) => timers.mock.calls.flatMap(([callback, delay], index) =>
    delay === milliseconds
      ? [{ callback: callback as () => void, timer: timers.mock.results[index]!.value as ReturnType<typeof setTimeout> }]
      : []);
  return {
    renewals, scheduled,
    fireCeiling(milliseconds: number, index = 0) {
      const ceiling = scheduled(milliseconds)[index];
      if (!ceiling) throw new Error('Expected a scheduled ceiling');
      clearTimeout(ceiling.timer);
      ceiling.callback();
    },
    async fire() {
      const next = scheduled().at(-1);
      if (!next) throw new Error('Expected a scheduled heartbeat');
      clearTimeout(next.timer);
      clock.advance(PREVIEW_LEASE_INTERVAL_MS);
      next.callback();
      await renewals.mock.results.at(-1)?.value;
    },
  };
}

async function seedTicket(f: Fixture, legacy = false) {
  const id = uuidv7(), { gymId } = f.actor;
  const prefix = legacy ? f.store.key(gymId, 'uploads', f.upload.id, `preview-requests/${id}`) : ticketPrefix(f, id);
  const lifetime = legacy ? { expiresAt: new Date(f.clock.now().getTime() + PREVIEW_LEASE_MS).toISOString() } : { leased: true };
  await f.store.put(gymId, `${prefix}/meta.json`, { prefix: 'unused', revision: '0.0.0.0', ...lifetime });
  await f.store.put(gymId, `${prefix}/computing.json`, {});
  if (!legacy) await f.store.renewLease(gymId, prefix, f.clock.now().getTime());
  return { id, prefix };
}

it('stops renewing at the ceiling, expires on both processes, and admits a new ticket', async () => {
  const budget = new PreviewBudget(1, 1), f = await fixture(budget, 1_000);
  const writer = f.writer(true), reader = f.reader(), start = f.clock.now().getTime();
  const heartbeat = watchHeartbeats(f.clock);
  const nextGate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  try {
    const id = pendingId(await writer.requestPreview(f.actor, f.plan, page, 'UTC'));
    await f.entered.promise;
    await heartbeat.fire();
    await heartbeat.fire();
    // The next heartbeat would be at 30 s, past the 22 s ceiling.
    expect(heartbeat.renewals.mock.calls.map(([, , now]) => now - start)).toEqual([0, 10_000, 20_000]);
    expect(heartbeat.scheduled()).toHaveLength(2);
    f.clock.advance(PREVIEW_LEASE_MS);
    expect(await poll(f, id, reader)).toMatchObject({ status: 'failed' });
    expect(await poll(f, id, writer)).toMatchObject({ status: 'failed' });

    const replacementWriter = f.writer(true, nextGate);
    const replacement = pendingId(await replacementWriter.requestPreview(f.actor, f.plan, page, 'UTC'));
    expect(replacement).not.toBe(id);
    const [current] = budget.pending.values();
    expect(current?.id).toBe(replacement);
    f.release.resolve();
    await nextGate.entered.promise;
    await expect.poll(async () => poll(f, id, reader)).toMatchObject({ status: 'failed', message: failureMessage });
    expect([...budget.pending.values()]).toEqual([current]);
    nextGate.release.resolve();
    await expect(current!.finished).rejects.toMatchObject({ message: failureMessage });
    await expect.poll(() => budget.pending.size).toBe(0);
  } finally {
    f.release.resolve();
    nextGate.release.resolve();
    await expect.poll(() => budget.pending.size).toBe(0);
  }
});

it('keeps a computing ticket live through ten heartbeats under the default ceiling', async () => {
  const budget = new PreviewBudget(), f = await fixture(budget), writer = f.writer();
  const heartbeat = watchHeartbeats(f.clock);
  try {
    const id = pendingId(await writer.requestPreview(f.actor, f.plan, page, 'UTC'));
    await f.entered.promise;
    for (let index = 0; index < 10; index++) await heartbeat.fire();
    expect(heartbeat.renewals).toHaveBeenCalledTimes(11);
    expect(await poll(f, id, f.reader())).toMatchObject({ status: 'computing' });
  } finally {
    f.release.resolve();
    await expect.poll(() => budget.pending.size).toBe(0);
  }
});

it('drops a queued ticket at its ceiling and admits a preview that was refused', async () => {
  const budget = new PreviewBudget(1, 1), f = await fixture(budget, 1_000);
  const writer = f.writer(), reader = f.reader(), heartbeat = watchHeartbeats(f.clock);
  const queuedPlan: ImportPlanRequest = { ...f.plan, mapping: [{ sourceColumn: 'Name', targetField: 'lastName' }] };
  const nextPlan: ImportPlanRequest = { ...f.plan, mapping: [{ sourceColumn: 'Name', targetField: 'email' }] };
  try {
    const first = pendingId(await writer.requestPreview(f.actor, f.plan, page, 'UTC'));
    await f.entered.promise;
    const queued = await writer.requestPreview(f.actor, queuedPlan, page, 'UTC');
    expect(queued.status).toBe('queued');
    const queuedId = pendingId(queued);
    await expect(writer.requestPreview(f.actor, nextPlan, page, 'UTC')).rejects.toThrow('queue is full');

    heartbeat.fireCeiling(22_000, 1);
    await expect.poll(() => poll(f, queuedId, reader)).toEqual({ status: 'failed', message: timedOut });
    const next = await writer.requestPreview(f.actor, nextPlan, page, 'UTC');
    expect(next.status).toBe('queued');
    f.release.resolve();
    await expect.poll(() => poll(f, first, reader)).toMatchObject({ status: 'ready' });
    await expect.poll(() => poll(f, pendingId(next), reader)).toMatchObject({ status: 'ready' });
  } finally {
    f.release.resolve();
    await expect.poll(() => budget.pending.size).toBe(0);
  }
});

it('stops a computing ticket at its ceiling, cleaning its rows before releasing the reservation', async () => {
  const budget = new PreviewBudget(1, 1);
  const f = await fixture(budget, 60_000, PREVIEW_FILE_ROWS + 1);
  const writer = f.writer(false, undefined, PREVIEW_FILE_ROWS / IMPORT_CHUNK_SIZE + 1);
  const heartbeat = watchHeartbeats(f.clock), nextGate = analysisGate(), replacementWriter = f.writer(false, nextGate);
  try {
    const first = pendingId(await writer.requestPreview(f.actor, f.plan, page, 'UTC'));
    await f.entered.promise;
    const [entry] = budget.pending.values();
    const failure = expect(entry!.finished).rejects.toMatchObject({ code: 'unavailable', message: timedOut });
    const root = f.store.key(f.actor.gymId, 'uploads', f.upload.id, 'preview/');
    const [rows] = (await f.storage.list(root)).filter(file => file.key.includes('/pages/'));
    expect(rows).toBeDefined();

    heartbeat.fireCeiling(140_000);
    const next = await replacementWriter.requestPreview(f.actor, f.plan, page, 'UTC');
    expect(next.status).toBe('queued');
    f.release.resolve();
    await nextGate.entered.promise;
    expect((await f.storage.head(rows!.key))?.deletedAt).toBeInstanceOf(Date);
    await failure;
    expect((await f.storage.list(root)).some(file => file.key.endsWith('/summary.json'))).toBe(false);
    await expect.poll(() => poll(f, first, f.reader())).toEqual({ status: 'failed', message: timedOut });
  } finally {
    f.release.resolve();
    nextGate.release.resolve();
    await expect.poll(() => budget.pending.size, { timeout: 5_000 }).toBe(0);
  }
});

it('times out the ticket when its summary write finishes after the ceiling', async () => {
  const budget = new PreviewBudget(1, 1), f = await fixture(budget, 1_000), writer = f.writer();
  const heartbeat = watchHeartbeats(f.clock), summary = analysisGate();
  const put = f.storage.put.bind(f.storage);
  vi.spyOn(f.storage, 'put').mockImplementation(async (key, body, contentType) => {
    if (key.endsWith('/summary.json')) {
      summary.entered.resolve();
      await summary.release.promise;
    }
    return put(key, body, contentType);
  });
  try {
    const id = pendingId(await writer.requestPreview(f.actor, f.plan, page, 'UTC'));
    f.release.resolve();
    await summary.entered.promise;
    heartbeat.fireCeiling(22_000);
    summary.release.resolve();
    await expect.poll(() => poll(f, id, f.reader())).toEqual({ status: 'failed', message: timedOut });
    expect(await writer.requestPreview(f.actor, f.plan, page, 'UTC')).toMatchObject({ status: 'ready' });
  } finally {
    f.release.resolve();
    summary.release.resolve();
    await expect.poll(() => budget.pending.size).toBe(0);
  }
});

it.each(['lease', 'meta'])('replaces a ticket whose first %s write hangs for one interval', async file => {
  const budget = new PreviewBudget(1, 1), f = await fixture(budget), writer = f.writer();
  const stalled = new Promise<never>(() => {}), entered = Promise.withResolvers<void>();
  const put = f.storage.put.bind(f.storage);
  let hung = false;
  vi.spyOn(f.storage, 'put').mockImplementation((key, body, contentType) => {
    if (!hung && key.includes('/preview/requests/') && (file === 'lease' ? key.includes('/lease/') : key.endsWith('/meta.json'))) {
      hung = true;
      entered.resolve();
      return stalled;
    }
    return put(key, body, contentType);
  });
  const get = vi.spyOn(f.storage, 'get');
  const first = writer.requestPreview(f.actor, f.plan, page, 'UTC');
  void first.catch(() => undefined);
  try {
    await entered.promise;
    const [original] = budget.pending.values();
    f.clock.advance(5_000);
    const joined = writer.requestPreview(f.actor, f.plan, page, 'UTC');
    void joined.catch(() => undefined);
    await expect.poll(() => get.mock.calls.filter(([key]) => key.endsWith('/summary.json')).length).toBe(4);
    expect([...budget.pending.values()].map(entry => entry.id)).toEqual([original!.id]);

    f.clock.advance(5_000);
    const replacement = pendingId(await writer.requestPreview(f.actor, f.plan, page, 'UTC'));
    expect(replacement).not.toBe(original!.id);
    for (const admission of [original!.admitted, first, joined]) {
      await expect(admission).rejects.toMatchObject({ code: 'unavailable', message: timedOut });
    }
    await expect(original!.finished).rejects.toMatchObject({ message: timedOut });
    const anotherPlan: ImportPlanRequest = { ...f.plan, mapping: [{ sourceColumn: 'Name', targetField: 'lastName' }] };
    expect((await writer.requestPreview(f.actor, anotherPlan, page, 'UTC')).status).toBe('queued');
  } finally {
    for (const entry of budget.pending.values()) if (entry.leaseUntil === 0) entry.stop();
    f.release.resolve();
    await expect.poll(() => budget.pending.size).toBe(0);
  }
});

it('accepts a 60-second lease and tolerates readers 20 seconds ahead or behind', async () => {
  const f = await fixture(), { id } = await seedTicket(f);
  const ahead = new TestClock(new Date(f.clock.now().getTime() + 20_000));
  const behind = new TestClock(new Date(f.clock.now().getTime() - 20_000));
  expect(await poll(f, id, f.reader(ahead))).toMatchObject({ status: 'computing' });
  expect(await poll(f, id, f.reader(behind))).toMatchObject({ status: 'computing' });
  const reader = f.reader();
  f.clock.advance(50_000);
  expect(await poll(f, id, reader)).toMatchObject({ status: 'computing' });
  f.clock.advance(10_000);
  expect(await poll(f, id, reader)).toMatchObject({ status: 'failed' });
});

it('reads new ticket metadata once and stops after the newest lease bucket hits', async () => {
  const f = await fixture(), { id, prefix } = await seedTicket(f);
  const head = vi.spyOn(f.storage, 'head'), get = vi.spyOn(f.storage, 'get');
  expect(await poll(f, id, f.reader())).toMatchObject({ status: 'computing' });
  expect(head.mock.calls.map(([key]) => key).filter(key => key.startsWith(prefix + '/lease/')))
    .toEqual([f.store.leaseKey(prefix, f.clock.now().getTime())]);
  expect(head.mock.calls.filter(([key]) => key === prefix + '/meta.json')).toHaveLength(1);
  expect(get.mock.calls.filter(([key]) => key === prefix + '/meta.json')).toHaveLength(1);
});

it('checks look-ahead buckets together after a backward miss and rereads the result', async () => {
  const f = await fixture(), { id, prefix } = await seedTicket(f);
  f.clock.advance(PREVIEW_LEASE_MS);
  const now = f.clock.now().getTime(), resultKey = prefix + '/result.json';
  const backward = Array.from({ length: 6 }, (_, index) => f.store.leaseKey(prefix, now - index * PREVIEW_LEASE_INTERVAL_MS));
  const ahead = [2, 1].map(index => f.store.leaseKey(prefix, now + index * PREVIEW_LEASE_INTERVAL_MS));
  const gate = Promise.withResolvers<null>(), calls: string[] = [];
  const get = f.storage.get.bind(f.storage), head = f.storage.head.bind(f.storage);
  vi.spyOn(f.storage, 'get').mockImplementation((key, options) => {
    if (key === resultKey) calls.push(key);
    return get(key, options);
  });
  vi.spyOn(f.storage, 'head').mockImplementation((key, options) => {
    if (key.startsWith(prefix + '/lease/')) calls.push(key);
    return ahead.includes(key) ? gate.promise : head(key, options);
  });
  const result = poll(f, id, f.reader());
  const beforeReread = [resultKey, ...backward, ...ahead];
  try {
    await expect.poll(() => calls).toEqual(beforeReread);
  } finally {
    gate.resolve(null);
  }
  await expect(result).resolves.toMatchObject({ status: 'failed' });
  expect(calls).toEqual([...beforeReread, resultKey]);
});

it('uses the fixed expiry on legacy tickets', async () => {
  const f = await fixture(), { id } = await seedTicket(f, true), reader = f.reader();
  expect(await poll(f, id, reader)).toMatchObject({ status: 'computing' });
  f.clock.advance(PREVIEW_LEASE_MS);
  expect(await poll(f, id, reader)).toMatchObject({ status: 'failed' });
});

it.each(['ready', 'failed'] as const)('marks every lease deleted after saving a %s result', async status => {
  const f = await fixture(), writer = f.writer(status === 'failed');
  const heartbeat = watchHeartbeats(f.clock);
  try {
    const id = pendingId(await writer.requestPreview(f.actor, f.plan, page, 'UTC'));
    await f.entered.promise;
    await heartbeat.fire();
    const prefix = ticketPrefix(f, id), first = f.clock.now().getTime() - PREVIEW_LEASE_INTERVAL_MS;
    const keys = [f.store.leaseKey(prefix, first), f.store.leaseKey(prefix, f.clock.now().getTime())];
    f.release.resolve();
    await expect.poll(async () => Promise.all(keys.map(async key => (await f.storage.head(key))?.deletedAt)))
      .toEqual([expect.any(Date), expect.any(Date)]);
    const result = await poll(f, id, f.reader());
    if (status === 'ready') expect(result).toMatchObject({ status, preview: { data: [{ values: { name: 'Pat' } }] } });
    else expect(result).toEqual({ status, message: failureMessage });
  } finally { f.release.resolve(); }
});

it('marks the newest eight lease keys together under one cleanup deadline', async () => {
  const budget = new PreviewBudget(), f = await fixture(budget), writer = f.writer();
  const heartbeat = watchHeartbeats(f.clock), cleanup = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds =>
    milliseconds === PREVIEW_CLEANUP_MS ? cleanup.signal : timeout(milliseconds));
  const mark = vi.spyOn(f.storage, 'markDeleted').mockImplementation(async (_key, options) => {
    const signal = options?.signal;
    if (!signal) throw new Error('Expected a cleanup signal');
    signal.throwIfAborted();
    return new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  try {
    const id = pendingId(await writer.requestPreview(f.actor, f.plan, page, 'UTC'));
    await f.entered.promise;
    for (let index = 0; index < 30; index++) await heartbeat.fire();
    const now = f.clock.now().getTime(), prefix = ticketPrefix(f, id);
    const newest = Array.from({ length: 8 }, (_, index) => f.store.leaseKey(prefix, now - index * PREVIEW_LEASE_INTERVAL_MS));
    f.release.resolve();
    await expect.poll(() => mark.mock.calls.length).toBe(8);
    expect(deadline.mock.calls.filter(([milliseconds]) => milliseconds === PREVIEW_CLEANUP_MS)).toHaveLength(1);
    expect(mark.mock.calls).toEqual(newest.map(key => [key, { signal: cleanup.signal }]));
    cleanup.abort();
    expect(await Promise.allSettled(mark.mock.results.map(result => result.value))).toEqual(
      newest.map(() => ({ status: 'rejected', reason: cleanup.signal.reason })));
    expect(mark).toHaveBeenCalledTimes(8);
    expect(await poll(f, id, f.reader())).toMatchObject({ status: 'ready' });
  } finally {
    cleanup.abort();
    f.release.resolve();
    await expect.poll(() => budget.pending.size).toBe(0);
  }
});

it('rereads a result saved between the first read and the lease check', async () => {
  const f = await fixture(), writer = f.writer(true);
  try {
    const id = pendingId(await writer.requestPreview(f.actor, f.plan, page, 'UTC'));
    await f.entered.promise;
    const prefix = ticketPrefix(f, id), resultKey = prefix + '/result.json';
    const leaseKey = f.store.leaseKey(prefix, f.clock.now().getTime());
    const get = f.storage.get.bind(f.storage);
    let resultReads = 0;
    vi.spyOn(f.storage, 'get').mockImplementation(async (key, options) => {
      if (key === resultKey && ++resultReads === 1) {
        f.release.resolve();
        await expect.poll(async () => (await f.storage.head(leaseKey))?.deletedAt).toBeInstanceOf(Date);
        return null;
      }
      return get(key, options);
    });
    expect(await poll(f, id, f.reader())).toEqual({ status: 'failed', message: failureMessage });
    expect(resultReads).toBe(2);
  } finally { f.release.resolve(); }
});
