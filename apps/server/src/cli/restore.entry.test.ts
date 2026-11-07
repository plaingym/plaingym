// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { KeyRotationPartialError, KeyRotationRefusedError } from './restore.rotate-key.js';

const mocks = vi.hoisted(() => ({ command: vi.fn(), close: vi.fn(), report: vi.fn(), resume: vi.fn() }));
vi.mock('@plaingym/db/client', () => ({ initializeDatabase: vi.fn(), closeDatabase: mocks.close }));
vi.mock('./restore.js', () => ({ maintenanceCommand: mocks.command, reportRestoreResume: mocks.resume }));
vi.mock('./restore.failure.js', () => ({ reportMaintenanceFailure: mocks.report }));
vi.mock('./restore.rotate-key.js', () => {
  class KeyRotationRefusedError extends Error { readonly exitCode: number = 3; }
  return { KeyRotationRefusedError, KeyRotationPartialError: class extends KeyRotationRefusedError { override readonly exitCode = 2; } };
});
const savedExitCode = process.exitCode;
const savedArgs = process.argv;
afterEach(() => { process.exitCode = savedExitCode; process.argv = savedArgs; vi.clearAllMocks(); });

it.each([
  [new Error('Unexpected failure'), 1],
  [new KeyRotationPartialError('Rerun with the same keys'), 2],
  [new KeyRotationRefusedError('Preflight refused'), 3],
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
