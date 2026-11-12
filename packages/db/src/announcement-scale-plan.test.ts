// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { announcementOptOuts, emailDeliveries, members } from './schema/index.js';
import { normalizedMemberAddress, normalizeAddress } from './schema/member-address.js';
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

it('uses the stored address index for announcement and cancellation groups with RLS enabled', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const household = await factory('households', gymId);
  const target = await factory('members', gymId, { householdId: household.id, email: '\t TARGET@example.test\u00a0' });
  for (let offset = 0; offset < 4000; offset += 500) await db.forGym(gymId, tx => tx.insert(members)
    .values(Array.from({ length: 500 }, (_, i) => ({ gymId, householdId: household.id, firstName: 'Bulk', lastName: String(offset + i),
      email: `member${offset + i}@example.test` }))));
  const maintenance = openConnection(db.maintenanceUrl, 1);
  try { await maintenance.sql`analyze members`; } finally { await maintenance.close(); }
  // Exercise both real query shapes: announcement's ID-or-address join, and cancellation's address-only read.
  for (const predicate of [sql`${members.id} = ${target.id} or ${members.emailAddress} = ${'target@example.test'}`,
    sql`${members.emailAddress} = ${'target@example.test'}`]) {
    const plan = await db.forGym(gymId, tx => tx.execute(sql`explain (analyze, buffers) select ${members.id}, ${members.email}
      from ${members} left join ${announcementOptOuts} on ${announcementOptOuts.memberId} = ${members.id}
      where (${predicate}) order by ${members.id}`));
    const text = plan.map(row => row['QUERY PLAN']).join('\n');
    expect(text).toContain('members_gym_address_idx');
    expect(text).not.toContain('Seq Scan on members');
    expect(text.split('\n').some(line => line.includes('Index Cond:') && line.includes('email_address') && line.includes('target@example.test'))).toBe(true);
    console.info('Address-group EXPLAIN (app role, RLS enabled):\n' + text);
  }
});

it('matches SQL address normalization to JavaScript trimming for every ECMAScript whitespace character', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const whitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  for (const char of whitespace) {
    const address = char + ' USER@example.test ' + char;
    const rows = await db.forGym(gymId, tx => tx.execute(sql`select ${normalizedMemberAddress(sql`${address}`)} as address`));
    expect(normalizeAddress(address)).toBe(address.trim().toLowerCase());
    expect(rows[0]!.address).toBe(normalizeAddress(address));
  }
});
