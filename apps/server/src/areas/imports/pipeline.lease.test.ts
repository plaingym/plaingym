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
import { PreviewBudget, PREVIEW_LEASE_INTERVAL_MS, PREVIEW_LEASE_MS, PREVIEW_TIMEOUT_MS } from './pipeline.budget.js';
import { PipelineStore } from './pipeline.store.js';
import { createImportPipeline } from './pipeline.js';

const database = useTestDatabase(), factory = createFactories(database);
const page = { limit: 10, offset: 0 };
const failureMessage = 'This mapping needs a name.';

afterEach(() => vi.restoreAllMocks());

async function fixture(previewBudget = new PreviewBudget(), previewTimeoutMs = PREVIEW_TIMEOUT_MS) {
  const gymId = uuidv7(), actor = { gymId, actor: { kind: 'system' } } as const;
  await factory('gyms', gymId);
  const clock = new TestClock('2099-10-24T00:00:00Z'), storage = new FakeUploads(gymId, clock);
  const uploadsFor = async () => storage;
  const options = { uploadsFor, jobs: new FakeJobs(clock), scope: database.forGym, clock };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  function writer(fail = false, gate = { entered, release }) {
    const mapper: CsvMapper = {
      id: 'people', available: true,
      async analyze(_tx, rows) {
        gate.entered.resolve();
        await gate.release.promise;
        if (fail) throw new AppError('invalid_request', failureMessage);
        return rows.map(row => ({ rowNumber: row.rowNumber, values: { name: 'Pat' }, action: 'create', duplicateIds: [], issues: [] }));
      },
      async commit() { return 0; },
    };
    return createImportPipeline({ ...options, previewBudget, previewTimeoutMs, mappers: new MapperRegistry([mapper]) });
  }
  const upload = await writer().upload(actor, new File(['Name\nPat\n'], 'people.csv'));
  const reader = (time = clock) => createImportPipeline({ ...options, clock: time, previewBudget: new PreviewBudget() });
  const plan: ImportPlanRequest = { uploadId: upload.id, mapper: 'people', duplicatePolicy: 'error',
    mapping: [{ sourceColumn: 'Name', targetField: 'firstName' }] };
  const store = new PipelineStore(uploadsFor);
  return { actor, clock, storage, store, reader, writer, upload, plan, entered, release };
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
  const scheduled = () => timers.mock.calls.flatMap(([callback, delay], index) =>
    delay === PREVIEW_LEASE_INTERVAL_MS
      ? [{ callback: callback as () => void, timer: timers.mock.results[index]!.value as ReturnType<typeof setTimeout> }]
      : []);
  return {
    renewals, scheduled,
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
