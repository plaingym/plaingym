// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { assertNoTransaction, isInTransaction, runInTransaction } from './transaction.js';

describe('transaction context', () => {
  it('carries context across awaits, returns results, and cleans up', async () => {
    expect(isInTransaction()).toBe(false);
    expect(
      await runInTransaction(async () => {
        await Promise.resolve();
        expect(isInTransaction()).toBe(true);
        expect(() => assertNoTransaction('network')).toThrow('network cannot run inside a transaction');
        return 42;
      }),
    ).toBe(42);
    expect(isInTransaction()).toBe(false);
    expect(() => assertNoTransaction('network')).not.toThrow();
  });
  it('cleans up after failure and rejects nested transactions', async () => {
    await expect(
      runInTransaction(async () => {
        await expect(
          runInTransaction(async () => {
            throw new Error('must not run');
          }),
        ).rejects.toThrow('Nested transaction');
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(isInTransaction()).toBe(false);
  });
  it('isolates concurrently executing async chains', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = runInTransaction(async () => {
      await held;
      expect(isInTransaction()).toBe(true);
    });
    await Promise.resolve();
    expect(isInTransaction()).toBe(false);
    assertNoTransaction('unrelated request');
    release();
    await transaction;
    expect(isInTransaction()).toBe(false);
  });
});
