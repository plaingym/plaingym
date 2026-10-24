// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { connectionBudget } from './client.js';

it('fits every budgeted connection into the shipped max_connections', async () => {
  const compose = await readFile(new URL('../../../deploy/compose.yaml', import.meta.url), 'utf8');
  const max = Number(/max_connections=(\d+)/.exec(compose)?.[1]);
  // Postgres keeps superuser_reserved_connections (default 3) out of reach of the app and maintenance roles.
  const available = max - 3;
  const used = Object.values(connectionBudget).reduce((total, count) => total + count, 0);
  expect(used).toBeLessThanOrEqual(available);
  expect(compose).not.toMatch(/superuser_reserved_connections/);
  expect(compose).not.toMatch(/DATABASE_POOL_MAX/);
});
