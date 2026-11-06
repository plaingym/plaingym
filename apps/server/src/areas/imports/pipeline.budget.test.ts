// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { PreviewBudget, previewDeadline } from './pipeline.budget.js';

it('admits small files together, queues a large file fairly, and releases reservations on failure', async () => {
  const budget = new PreviewBudget(16 * 1024 * 1024), order: string[] = [];
  const a = Promise.withResolvers<void>(), b = Promise.withResolvers<void>(), large = Promise.withResolvers<void>();
  const first = budget.run(1, 1, async () => { order.push('a'); await a.promise; });
  const second = budget.run(1, 1, async () => { order.push('b'); await b.promise; });
  const third = budget.run(20 * 1024 * 1024, 100_000, async () => { order.push('large'); await large.promise; throw new Error('failed'); });
  const rejection = expect(third).rejects.toThrow('failed');
  const fourth = budget.run(1, 1, async () => { order.push('last'); });
  await Promise.resolve(); expect(order).toEqual(['a', 'b']);
  a.resolve(); await first; expect(order).toEqual(['a', 'b']);
  b.resolve(); await second; expect(order).toEqual(['a', 'b', 'large']);
  large.resolve(); await rejection; await fourth; expect(order).toEqual(['a', 'b', 'large', 'last']);
});

it('aborts the computation itself and waits for cancellation before releasing its budget', async () => {
  const budget = new PreviewBudget(1), entered = Promise.withResolvers<void>(), stopping = Promise.withResolvers<void>();
  let stopped = false;
  const first = budget.run(1, 1, () => previewDeadline(20, async (signal) => {
    entered.resolve();
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    await stopping.promise; stopped = true; signal.throwIfAborted();
  }));
  const rejection = expect(first).rejects.toThrow('took too long');
  await entered.promise;
  let started = false;
  const next = budget.run(1, 1, async () => { expect(stopped).toBe(true); started = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(started).toBe(false); stopping.resolve(); await rejection; await next;
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
