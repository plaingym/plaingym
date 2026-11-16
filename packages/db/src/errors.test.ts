// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { databaseCode, errorCauses } from './errors.js';
import { isConnectionError } from './client.js';

it('walks object and Error causes in order, keeping the first string code', () => {
  const driver = { code: '08006' }, wrapper = Object.assign(new Error('query', { cause: driver }), { code: '23505' });
  const outer = { code: 42, cause: wrapper };
  expect([...errorCauses(outer)]).toEqual([outer, wrapper, driver]);
  expect(databaseCode(outer)).toBe('23505');
  expect(isConnectionError(outer)).toBe(true);
});

it('terminates on primitive causes and cycles, including a cycle with a code', () => {
  const cyclic: { cause?: unknown; code?: string } = {};
  cyclic.cause = new Error('inner', { cause: cyclic });
  expect([...errorCauses(cyclic)]).toHaveLength(2);
  expect(databaseCode(cyclic)).toBeUndefined();
  expect(isConnectionError(cyclic)).toBe(false);
  cyclic.code = 'ECONNRESET';
  expect(databaseCode(cyclic)).toBe('ECONNRESET');
  expect(isConnectionError(cyclic)).toBe(true);
  for (const value of [undefined, null, false, 42, '08006', { cause: '08006' }, { code: 8006 }]) {
    expect(databaseCode(value)).toBeUndefined();
    expect(isConnectionError(value)).toBe(false);
  }
});

it('handles a deep cause chain without recursion', () => {
  let error: unknown = { code: '23503' };
  for (let depth = 0; depth < 20_000; depth++) error = { cause: error };
  expect(databaseCode(error)).toBe('23503');
  expect(isConnectionError(error)).toBe(false);
});
