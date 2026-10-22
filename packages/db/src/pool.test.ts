// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { uuidv7 } from './id.js';
import { households } from './schema/members.js';
import { createFactories } from './testing/factories.js';
import { useTestDatabase } from './testing/database.js';
import { assertNoTransaction, isInTransaction } from '@plaingym/shared/transaction';
const database = useTestDatabase();
it('uses exactly two pooled connections without context leaks after commits or rollbacks', async () => {
  const factory = createFactories(database);
  const gyms = Array.from({ length: 8 }, () => uuidv7());
  for (const gym of gyms) await factory('gyms', gym);
  const pids = new Set<number>();
  let committed = 0, rolledBack = 0;
  await Promise.all(gyms.map(async (gymId) => {
    for (let i = 0; i < 40; i++) {
      const rollback = i % 7 === 0;
      try {
        await database.forGym(gymId, async (tx) => {
          const [context] = await tx.execute<{ gym: string; pid: number }>(sql`select current_setting('app.gym_id') as gym, pg_backend_pid() as pid`);
          expect(context!.gym).toBe(gymId); pids.add(context!.pid);
          expect(isInTransaction()).toBe(true);
          expect(() => assertNoTransaction('payment')).toThrow();
          expect((await tx.select().from(households)).every((row) => row.gymId === gymId)).toBe(true);
          await tx.insert(households).values({ gymId, name: 'Pool fixture' });
          if (rollback) throw new Error('deliberate rollback');
        });
        committed++;
      } catch (error) {
        if (!rollback || !(error instanceof Error) || error.message !== 'deliberate rollback') throw error;
        rolledBack++;
      }
      expect(isInTransaction()).toBe(false);
      const [context] = await database.app.sql`select nullif(current_setting('app.gym_id', true), '') as gym`;
      expect(context!.gym).toBeNull();
      expect(await database.app.db.select().from(households)).toEqual([]);
    }
  }));
  expect(pids.size).toBe(2); expect(committed).toBe(272); expect(rolledBack).toBe(48);
  for (const gym of gyms) expect(await database.forGym(gym, (tx) => tx.select().from(households))).toHaveLength(34);
});
it('rejects nested scopes and malformed context without taking another connection', async () => {
  const gym = uuidv7(); await createFactories(database)('gyms', gym);
  await database.forGym(gym, async () => {
    await expect(database.forGym(gym, async () => undefined)).rejects.toThrow();
  });
  await expect(database.forGym('not-a-uuid', async () => undefined)).rejects.toThrow('UUID');
  await expect(database.app.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.gym_id', 'invalid', true)`);
    await tx.select().from(households);
  })).rejects.toMatchObject({ cause: { code: '22P02' } });
});
