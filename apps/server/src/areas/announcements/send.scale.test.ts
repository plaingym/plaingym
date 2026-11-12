// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { memberRanks, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { announcementDraftSchema } from '@plaingym/shared/contracts';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createAnnouncementsService } from './send.js';

const db = useTestDatabase(), factory = createFactories(db);
interface Read { sql: string; rows: number }
// Count actual executed SELECTs and returned rows, including the final transport guard.
function recording(reads: Read[]): typeof db.forGym {
  const watch = <T extends object>(builder: T): T => new Proxy(builder, { get(target, key, receiver) {
    const value = Reflect.get(target, key) as unknown;
    if (typeof value !== 'function' || key === 'constructor') return value;
    if (key === 'then') return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) => {
      const sql = (target as unknown as { toSQL(): { sql: string } }).toSQL().sql;
      return (target as unknown as PromiseLike<unknown>).then(rows => {
        reads.push({ sql, rows: Array.isArray(rows) ? rows.length : 1 });
        return resolve(rows);
      }, reject);
    };
    return (...args: unknown[]) => {
      const result = (value as (...a: unknown[]) => unknown).apply(target, args);
      return result === target ? receiver : typeof result === 'object' && result !== null && 'toSQL' in result ? watch(result) : result;
    };
  } });
  return (gymId, fn) => db.forGym(gymId, tx => fn(new Proxy(tx, { get(target, key) {
    const value = Reflect.get(target, key) as unknown;
    if (key === 'select' && typeof value === 'function') return (...args: unknown[]) => watch((value as (...a: unknown[]) => object).apply(target, args));
    return typeof value === 'function' ? value.bind(target) : value;
  } })));
}

it.each([25, 250])('bounds recipient reads and rank rows in a %i-member send', async size => {
  const gymId = uuidv7(), clock = new TestClock('2026-11-10T12:00:00Z');
  await factory('gyms', gymId, { memberEmailsEnabled: true });
  const household = await factory('households', gymId), user = await factory('authUser', gymId);
  await factory('staffRoles', gymId, { userId: user.id, role: 'owner' });
  const system = await factory('rankSystems', gymId), rank = await factory('ranks', gymId, { rankSystemId: system.id });
  const program = await factory('programs', gymId, { rankSystemId: system.id });
  const people = await db.forGym(gymId, tx => tx.insert(members).values(Array.from({ length: size }, (_, i) => ({
    gymId, householdId: household.id, firstName: 'Bulk', lastName: String(i), status: 'active', email: `member${i}@example.test`,
  }))).returning({ id: members.id }));
  await db.forGym(gymId, tx => tx.insert(memberRanks).values(people.map(person => ({ gymId, memberId: person.id,
    programId: program.id, rankId: rank.id, rankSystemId: system.id, promotedAt: clock.now() }))));
  const reads: Read[] = [], email = new FakeEmail();
  const service = createAnnouncementsService({ scope: recording(reads), clock, jobs: new FakeJobs(clock),
    smtp: { configured: async () => true }, mailer: async () => { expect(isInTransaction()).toBe(false); return email; },
    origin: async () => 'https://gym.example.test', senderEmail: async () => user.email });
  const row = await service.send({ gymId, userId: user.id }, { ...announcementDraftSchema.parse({ subject: 'Notice', body: 'See you soon',
    audience: { statuses: ['active'], programIds: [program.id] } }), confirm: true, sendGeneration: uuidv7() });
  reads.length = 0;
  await service.run({ announcementId: row.id }, gymId);
  expect(email.messages).toHaveLength(size);
  expect(new Set(email.messages.map(message => message.to)).size).toBe(size);
  const groups = reads.filter(read => read.sql.includes('left join "announcement_opt_outs"'));
  const ranks = reads.filter(read => read.sql.includes('from "member_ranks"'));
  expect(groups).toHaveLength(size); expect(ranks).toHaveLength(size);
  expect(groups.every(read => read.rows === 1 && read.sql.includes('"members"."email_address"') && !read.sql.includes('ilike'))).toBe(true);
  expect(ranks.every(read => read.rows === 1 && read.sql.includes('"member_ranks"."member_id" in'))).toBe(true);
  expect(reads.length).toBeLessThanOrEqual(size * 14 + 10);
  expect(reads.reduce((total, read) => total + read.rows, 0)).toBeLessThanOrEqual(size * 15 + 60);
  console.info(`Announcement scale: ${size} recipients, ${reads.length} SELECTs, ${reads.reduce((total, read) => total + read.rows, 0)} returned rows`);
}, 90_000);

