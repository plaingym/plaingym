// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { AppError } from '@plaingym/shared';
import { createReplayCommand } from './replay.js';

const gymId = '00000000-0000-7000-8000-000000000001';
it.each([[], ['evt_one'], ['--gym', 'invalid', 'evt_one'], ['--gym', gymId, 'evt_one', 'extra']])('rejects invalid arguments without queueing: %j', async (...args) => {
  const replay = vi.fn(), stdout = vi.fn(), stderr = vi.fn();
  expect(await createReplayCommand(replay).run(args, { stdout, stderr })).toBe(2);
  expect(replay).not.toHaveBeenCalled(); expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
});
it('requires an explicit gym and queues only the specified stored event', async () => {
  const replay = vi.fn().mockResolvedValue({ jobId: 'job_one' }), stdout = vi.fn(), stderr = vi.fn();
  expect(await createReplayCommand(replay).run(['--gym', gymId, 'evt_one'], { stdout, stderr })).toBe(0);
  expect(replay).toHaveBeenCalledExactlyOnceWith(gymId, 'evt_one'); expect(stdout).toHaveBeenCalledWith('Webhook replay queued: job_one');
});
it.each([new AppError('not_found', 'Webhook event not found'), new Error('secret provider response')])('reports safe failures', async (error) => {
  const replay = vi.fn().mockRejectedValue(error), stdout = vi.fn(), stderr = vi.fn();
  expect(await createReplayCommand(replay).run(['--gym', gymId, 'evt_one'], { stdout, stderr })).toBe(1);
  expect(stderr).toHaveBeenCalledWith(error instanceof AppError ? error.message : 'Unable to queue webhook replay');
  expect(stdout).not.toHaveBeenCalled();
});
