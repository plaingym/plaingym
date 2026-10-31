// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { floodLimit, poolSize, startRuntime, runCommandLine } from './runtime.js';
import { demoEnv, origin } from './runtime.fixture.test-helper.js';

const database = useTestDatabase();

it('sizes the app pool from DATABASE_POOL_MAX within the connection budget', () => {
  expect(poolSize({})).toBe(8);
  expect(poolSize({ DATABASE_POOL_MAX: '4' })).toBe(4);
  for (const value of ['0', '-1', '1.5', 'many', '101']) expect(() => poolSize({ DATABASE_POOL_MAX: value })).toThrow('DATABASE_POOL_MAX');
});
it('reads the flood limit from RATE_LIMIT_PER_MINUTE, leaving the default when unset', () => {
  expect(floodLimit({})).toBeUndefined();
  expect(floodLimit({ RATE_LIMIT_PER_MINUTE: '20000' })).toBe(20_000);
  for (const value of ['', '0', '-1', '1.5', 'many', '100001']) expect(() => floodLimit({ RATE_LIMIT_PER_MINUTE: value })).toThrow('RATE_LIMIT_PER_MINUTE');
});
it('migrates through the maintenance role from the command line, without the app settings', async () => {
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  try {
    vi.stubEnv('MAINTENANCE_DATABASE_URL', '');
    expect(await runCommandLine(['migrate'], io, {})).toBe(1);
    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('MAINTENANCE_DATABASE_URL'));
    // The test database is already migrated, so this proves the command is safe to repeat.
    vi.stubEnv('MAINTENANCE_DATABASE_URL', database.maintenanceUrl);
    expect(await runCommandLine(['migrate'], io, {})).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith('Database migrated');
  } finally { vi.unstubAllEnvs(); }
});
it('refuses live keys before trying to open a database', async () => {
  await expect(startRuntime({ ...demoEnv('invalid', 'http://127.0.0.1:9', '/staging'), STRIPE_KEY: 'sk_live_forbidden' })).rejects.toThrow(/live/);
});
it('reprints the setup link without requiring a database connection', async () => {
  const io = { stdout: vi.fn(), stderr: vi.fn() }, token = 'private-installer-token-at-least-32-characters';
  expect(await runCommandLine(['setup-link'], io, { PUBLIC_ORIGIN: origin, SETUP_TOKEN: token })).toBe(0);
  expect(io.stdout).toHaveBeenCalledWith(origin + '/setup#token=' + token);
  expect(await runCommandLine(['setup-link'], io, { PUBLIC_ORIGIN: origin })).toBe(1);
});
