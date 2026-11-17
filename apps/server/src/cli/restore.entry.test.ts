// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { KeyRotationPartialError, KeyRotationRefusedError, KeyRotationUnstartedError } from './restore.rotate-key.js';

const mocks = vi.hoisted(() => ({ command: vi.fn(), initialize: vi.fn(), close: vi.fn(), report: vi.fn(), resume: vi.fn() }));
vi.mock('@plaingym/db/client', () => ({ initializeDatabase: mocks.initialize, closeDatabase: mocks.close }));
vi.mock('./restore.js', () => ({ maintenanceCommand: mocks.command, reportRestoreResume: mocks.resume, snapshotCheckTimeoutMs: 30_000 }));
vi.mock('./restore.failure.js', () => ({ reportMaintenanceFailure: mocks.report }));
vi.mock('./restore.rotate-key.js', () => {
  class KeyRotationRefusedError extends Error { readonly exitCode: number = 3; }
  return { KeyRotationRefusedError, KeyRotationPartialError: class extends KeyRotationRefusedError { override readonly exitCode = 2; },
    KeyRotationUnstartedError: class extends KeyRotationRefusedError { override readonly exitCode = 4; } };
});
const savedExitCode = process.exitCode;
const savedArgs = process.argv;
afterEach(() => { process.exitCode = savedExitCode; process.argv = savedArgs; vi.clearAllMocks(); });

it.each([
  [new Error('Unexpected failure'), 1],
  [new KeyRotationPartialError('Rerun with the same keys'), 2],
  [new KeyRotationRefusedError('Preflight refused'), 3],
  [new KeyRotationUnstartedError('No value uses the new key'), 4],
] as const)('maps the maintenance failure exit status and still closes the database (%s)', async (error, status) => {
  vi.resetModules();
  process.argv = ['node', 'maintenance.mjs', 'rotate-key'];
  mocks.command.mockRejectedValueOnce(error);
  await import('./restore.entry.js');
  expect(process.exitCode).toBe(status);
  expect(mocks.report).toHaveBeenCalledWith(expect.any(Array), error);
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.resume).not.toHaveBeenCalled();
});

it.each(['initialize', 'close'] as const)('bounds snapshot-check while database %s never settles', async phase => {
  vi.resetModules(); vi.useFakeTimers();
  vi.stubEnv('DATABASE_URL', 'postgres://app:unused@127.0.0.1:1/unused');
  let finish!: () => void;
  mocks[phase].mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  process.argv = ['node', 'maintenance.mjs', 'snapshot-check', '00000000-0000-4000-8000-000000000001'];
  try {
    const entry = import('./restore.entry.js');
    await vi.waitFor(() => expect(mocks[phase]).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(stderr).toHaveBeenCalledWith('Snapshot availability check timed out\n');
    finish(); await entry;
    expect(vi.getTimerCount()).toBe(0);
  } finally { exit.mockRestore(); stderr.mockRestore(); vi.useRealTimers(); vi.unstubAllEnvs(); }
});
