// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { PreviewBudget, previewDeadline } from './pipeline.budget.js';

it('bounds the waiting queue without refusing an immediately available slot', async () => {
  const budget = new PreviewBudget(1, 1), release = Promise.withResolvers<void>();
  const active = budget.run('a', 1, 1, () => release.promise);
  const queued = budget.run('a', 1, 1, async () => 'next');
  expect(() => budget.run('b', 1, 1, async () => 'overflow')).toThrow('queue is full');
  release.resolve(); await active; expect(await queued).toBe('next');
  expect(await budget.run('a', 1, 1, async () => 'free')).toBe('free');
});

it('admits small files together, queues a large file fairly, and releases reservations on failure', async () => {
  const budget = new PreviewBudget(16 * 1024 * 1024), order: string[] = [];
  const a = Promise.withResolvers<void>(), b = Promise.withResolvers<void>(), large = Promise.withResolvers<void>();
  const first = budget.run('a', 1, 1, async () => { order.push('a'); await a.promise; });
  const second = budget.run('b', 1, 1, async () => { order.push('b'); await b.promise; });
  const third = budget.run('a', 20 * 1024 * 1024, 100_000, async () => { order.push('large'); await large.promise; throw new Error('failed'); });
  const rejection = expect(third).rejects.toThrow('failed');
  const fourth = budget.run('b', 1, 1, async () => { order.push('last'); });
  await Promise.resolve(); expect(order).toEqual(['a', 'b']);
  a.resolve(); await first; expect(order).toEqual(['a', 'b']);
  b.resolve(); await second; expect(order).toEqual(['a', 'b', 'large']);
  large.resolve(); await rejection; await fourth; expect(order).toEqual(['a', 'b', 'large', 'last']);
});

it('gives a new gym a turn before the second preview from the first gym', async () => {
  const budget = new PreviewBudget(16 * 1024 * 1024), order: string[] = [];
  const release = Promise.withResolvers<void>(), large = 20 * 1024 * 1024;
  const active = budget.run('a', large, 1, async () => { order.push('a1'); await release.promise; });
  const queued = ['a2', 'a3'].map(name => budget.run('a', large, 1, async () => { order.push(name); }));
  const small = budget.run('b', 1, 1, async () => { order.push('b'); });

  await Promise.resolve();
  expect(order).toEqual(['a1']);
  release.resolve();
  await Promise.all([active, ...queued, small]);
  expect(order).toEqual(['a1', 'b', 'a2', 'a3']);
});

it('admits a new gym beside running work and preserves the older turn after that admission', async () => {
  const mib = 1024 * 1024, budget = new PreviewBudget(128 * mib), order: string[] = [];
  const release = Promise.withResolvers<void>();
  // Each large preview reserves just over 68 MiB, so a small preview fits beside one.
  const first = budget.run('a', 8 * mib, 1, async () => { order.push('a1'); await release.promise; });
  const second = budget.run('a', 8 * mib, 1, async () => { order.push('a2'); });
  const small = budget.run('b', 1, 1, async () => { order.push('b'); });
  await Promise.resolve();
  expect(order).toEqual(['a1', 'b']);
  await small;

  const later = budget.run('c', 1, 1, async () => { order.push('c'); });
  await Promise.resolve();
  expect(order).toEqual(['a1', 'b']);
  release.resolve();
  await Promise.all([first, second, later]);
  expect(order).toEqual(['a1', 'b', 'a2', 'c']);
});

it('keeps three waiting gyms within the shared memory budget', async () => {
  const budget = new PreviewBudget(12 * 1024 * 1024), order: string[] = [];
  const release = Promise.withResolvers<void>();
  const active = budget.run('a', 20 * 1024 * 1024, 1, () => release.promise);
  const gates = ['a', 'b', 'c'].map(() => Promise.withResolvers<void>());
  // Each preview reserves just over 4 MiB, so only two fit together.
  const queued = ['a', 'b', 'c'].map((gym, index) => budget.run(gym, 1, 1, async () => {
    order.push(gym);
    await gates[index]!.promise;
  }));

  release.resolve();
  await active;
  expect(order).toEqual(['b', 'c']);
  gates[1]!.resolve();
  await queued[1];
  expect(order).toEqual(['b', 'c', 'a']);
  gates[0]!.resolve();
  gates[2]!.resolve();
  await Promise.all(queued);
});

it('aborts the computation itself and waits for cancellation before releasing its budget', async () => {
  const budget = new PreviewBudget(1), entered = Promise.withResolvers<void>(), stopping = Promise.withResolvers<void>();
  let stopped = false;
  const first = budget.run('a', 1, 1, () => previewDeadline(20, async (signal) => {
    entered.resolve();
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    await stopping.promise; stopped = true; signal.throwIfAborted();
  }));
  const rejection = expect(first).rejects.toThrow('took too long');
  await entered.promise;
  let started = false;
  const next = budget.run('b', 1, 1, async () => { expect(stopped).toBe(true); started = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(started).toBe(false); stopping.resolve(); await rejection; await next;
});

it.each([
  { limit: undefined, expected: 3 },
  { limit: 2, expected: 2 },
])('caps each gym at $expected waiting previews and frees a place on admission', async ({ limit, expected }) => {
  const budget = new PreviewBudget(1, 16, limit), release = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const active = budget.run('a', 1, 1, () => release.promise);
  const waiting = Array.from({ length: expected }, () => budget.run('a', 1, 1, () => finish.promise));
  expect(() => budget.run('a', 1, 1, async () => 'overflow')).toThrow('queue is full');
  const other = budget.run('b', 1, 1, async () => 'b');
  release.resolve();
  await Promise.all([active, other]);
  const next = budget.run('a', 1, 1, async () => 'next');
  expect(() => budget.run('a', 1, 1, async () => 'overflow')).toThrow('queue is full');
  finish.resolve();
  await Promise.all(waiting);
  expect(await next).toBe('next');
  expect(await budget.run('a', 1, 1, async () => 'free')).toBe('free');
});

it.each(['AbortError', 'TimeoutError'])('answers a provider %s as a timed-out preview and keeps other failures', async name => {
  const stopped = previewDeadline(1, (signal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', name)), { once: true });
  }));
  await expect(stopped).rejects.toMatchObject({ code: 'unavailable', status: 503 });
  await expect(previewDeadline(60_000, async () => { throw new Error('failed'); })).rejects.toThrow('failed');
});

it('preserves a storage failure that arrives after cancellation', async () => {
  const failure = new Error('storage permission denied');
  await expect(previewDeadline(10, signal => new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(failure), { once: true });
  }))).rejects.toBe(failure);
});

it('preserves a connection reset the S3 client renamed to TimeoutError', async () => {
  const reset = Object.assign(new Error('read ECONNRESET'), { name: 'TimeoutError', code: 'ECONNRESET' });
  await expect(previewDeadline(10, signal => new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(reset), { once: true });
  }))).rejects.toBe(reset);
});

it('keeps the result of work that finished past its deadline', async () => {
  const now = vi.spyOn(performance, 'now');
  try {
    await expect(previewDeadline(60_000, async () => { now.mockReturnValue(Number.MAX_SAFE_INTEGER); return 'stored'; })).resolves.toBe('stored');
  } finally { now.mockRestore(); }
});

it('cancels sibling reads when computation fails before its deadline', async () => {
  const cancelled = Promise.withResolvers<void>();
  await expect(previewDeadline(60_000, async signal => {
    signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    throw new Error('metadata failed');
  })).rejects.toThrow('metadata failed');
  await cancelled.promise;
});
