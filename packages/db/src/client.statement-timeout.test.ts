// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { currentStatementTimeout, openConnection, scopedDatabase, withStatementTimeout, type Connection } from './client.js';
import { databaseCode } from './errors.js';
import { useTestDatabase } from './testing/database.js';

const database = useTestDatabase();
const gymId = randomUUID();
// One connection, so every scope below reuses the connection the limit was set on.
let connection: Connection;
let scopes: ReturnType<typeof scopedDatabase>;
beforeAll(() => {
  connection = openConnection(database.appUrl, 1);
  scopes = scopedDatabase(connection.db);
});
afterAll(async () => { await connection?.close(); });

async function rejection(work: Promise<unknown>) {
  const started = performance.now();
  const error = await work.then(() => undefined, (caught: unknown) => caught);
  return { code: databaseCode(error), ms: performance.now() - started };
}
const settings = async () => scopes.forGym(gymId, async (tx) => {
  const [row] = await tx.execute<{ timeout: string; gym: string }>(
    sql`select current_setting('statement_timeout') as timeout, current_setting('app.gym_id') as gym`);
  return row;
});

it('cancels a gym-scope statement past the limit', async () => {
  const result = await rejection(withStatementTimeout(200, () =>
    scopes.forGym(gymId, (tx) => tx.execute(sql`select pg_sleep(2)`))));
  expect(result.code).toBe('57014');
  expect(result.ms).toBeLessThan(1500);
});

it('cancels a system-scope statement past the limit', async () => {
  const result = await rejection(withStatementTimeout(200, () =>
    scopes.forSystem((tx) => tx.execute(sql`select pg_sleep(2)`))));
  expect(result.code).toBe('57014');
  expect(result.ms).toBeLessThan(1500);
});

it('leaves the next transaction on the same connection without the limit', async () => {
  await rejection(withStatementTimeout(200, () => scopes.forGym(gymId, (tx) => tx.execute(sql`select pg_sleep(2)`))));
  expect((await settings())?.timeout).toBe('0');
  await expect(scopes.forGym(gymId, (tx) => tx.execute(sql`select pg_sleep(0.5)`))).resolves.toBeDefined();
  await expect(scopes.forSystem((tx) => tx.execute(sql`select pg_sleep(0.5)`))).resolves.toBeDefined();
});

it('sets the limit after the gym context and only inside the wrapper', async () => {
  expect(currentStatementTimeout()).toBeUndefined();
  const inside = await withStatementTimeout(5000, async () => {
    expect(currentStatementTimeout()).toBe(5000);
    return settings();
  });
  expect(inside).toEqual({ timeout: '5s', gym: gymId });
  expect(currentStatementTimeout()).toBeUndefined();
  expect((await settings())?.timeout).toBe('0');
});

it('refuses a limit that is not a positive integer before any query', () => {
  let ran = false;
  const work = async () => { ran = true; };
  for (const ms of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => withStatementTimeout(ms, work)).toThrow('Statement timeout must be a positive integer');
  expect(ran).toBe(false);
});
