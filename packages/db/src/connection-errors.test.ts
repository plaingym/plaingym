// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { isConnectionError, openConnection } from './client.js';
import { useTestDatabase } from './testing/database.js';

const database = useTestDatabase();
const failure = (run: () => Promise<unknown>) => run().then(() => { throw new Error('expected a failure'); }, (error: unknown) => error);

describe('isConnectionError', () => {
  it('recognizes a refused connection from the driver, through the ORM\'s wrapping', async () => {
    const closed = openConnection('postgres://app:unused@127.0.0.1:1/none', 1);
    try {
      const error = await failure(() => closed.db.execute(sql`select 1`));
      expect(isConnectionError(error)).toBe(true);
    } finally { await closed.close(); }
  });
  it('recognizes a read-only server, and not an ordinary query error, from the driver', async () => {
    const readOnly = await failure(() => database.forSystem(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      await tx.execute(sql`create temporary table connection_errors_probe (id int)`);
    }));
    expect(isConnectionError(readOnly)).toBe(true);
    const ordinary = await failure(() => database.forSystem((tx) => tx.execute(sql`select 1 / 0`)));
    expect(isConnectionError(ordinary)).toBe(false);
  });
  it.each(['08006', '08P01', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECT_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET',
    '25006', '28000', '28P01', '53300', '57P01', '57P02', '57P03', '57P04'])('treats %s, wrapped as a cause, as a connection error', (code) => {
    expect(isConnectionError(new Error('query failed', { cause: Object.assign(new Error('driver'), { code }) }))).toBe(true);
  });
  it.each(['23505', '23503', '40001', '40P01', '42P01', '53200', '57014', 'ERR_INVALID_ARG_TYPE'])('does not treat %s as a connection error', (code) => {
    expect(isConnectionError(Object.assign(new Error('query failed'), { code }))).toBe(false);
  });
  it('ignores values without a code and stops at a cause cycle', () => {
    const cyclic = new Error('outer') as Error & { cause?: unknown };
    cyclic.cause = new Error('inner', { cause: cyclic });
    for (const value of [undefined, null, 'ECONNREFUSED', { code: 8006 }, cyclic]) expect(isConnectionError(value)).toBe(false);
  });
});
