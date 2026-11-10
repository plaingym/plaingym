// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { emailDeliveries } from './schema/index.js';
import { useTestDatabase } from './testing/database.js';
import { createFactories } from './testing/factories.js';

const db = useTestDatabase(), factory = createFactories(db);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
it('uses the gym/digest index for a duplicate-address lookup among durable delivery history', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const digest = hash('announcement-recipient');
  for (let offset = 0; offset < 4000; offset += 500) await db.forGym(gymId, tx => tx.insert(emailDeliveries)
    .values(Array.from({ length: 500 }, (_, i) => ({ gymId, key: `history:${offset + i}`, state: 'accepted', updatedAt: new Date('2026-11-10T12:00:00Z'),
      commandDigest: offset + i === 2000 ? digest : hash(String(offset + i)) }))));
  const maintenance = openConnection(db.maintenanceUrl, 1);
  try { await maintenance.sql`analyze email_deliveries`; } finally { await maintenance.close(); }
  const plan = await db.app.sql.begin(async sql => {
    await sql`select set_config('app.gym_id', ${gymId}, true)`;
    return sql`explain (analyze, buffers) select id from email_deliveries where gym_id = ${gymId} and command_digest = ${digest} limit 1`;
  });
  const text = plan.map(row => row['QUERY PLAN']).join('\n');
  expect(text).toContain('email_deliveries_command_idx');
  expect(text).not.toContain('Seq Scan');
  console.info('Duplicate-address EXPLAIN (app role, RLS enabled):\n' + text);
});
