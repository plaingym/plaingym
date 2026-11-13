// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { asc } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { households, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { ImportColumnMapping, ImportPlanRequest } from '@plaingym/shared/contracts';
import { TestClock } from '../../../core/clock.js';
import { FakeUploads } from '../../../infra/storage/index.js';
import { FakeJobs } from '../../../infra/jobs/index.js';
import { createImportPipeline, IMPORT_CHUNK_SIZE } from '../pipeline.js';
import { autoMatch, parseCsv } from '../pipeline.csv.js';
import { peopleMapper } from './people.js';
import { familyExport, minimalExport } from './people.fixtures.js';
import { richPeople, seedMembers } from './people.compat.fixtures.js';
import type { MapperContext } from './registry.js';

const database = useTestDatabase();
// Reference digests include every planned value, action, duplicate ID and issue, in source order.
const expected = [
  '2a330fca35b7b1c24608dcee3882fae64c11208e5bd88824fb46238e8bd9794d',
  '2a330fca35b7b1c24608dcee3882fae64c11208e5bd88824fb46238e8bd9794d',
  '2f3ba7effe88ffecdd9aa6b49dfeb65beb2eaf83dfa7402a1482b7432b73c751',
  'e74126e67e922760864ee3d47994026529788b4fa73a6d4795ce936c018ca907',
  '2a330fca35b7b1c24608dcee3882fae64c11208e5bd88824fb46238e8bd9794d',
  '670f5e756de59ac3755831936a6f9146eb8cdbf4f3958af9ab0dcb53adc650d4',
  '670f5e756de59ac3755831936a6f9146eb8cdbf4f3958af9ab0dcb53adc650d4',
  '670f5e756de59ac3755831936a6f9146eb8cdbf4f3958af9ab0dcb53adc650d4',
  '670f5e756de59ac3755831936a6f9146eb8cdbf4f3958af9ab0dcb53adc650d4',
  '670f5e756de59ac3755831936a6f9146eb8cdbf4f3958af9ab0dcb53adc650d4',
  'b78850f43c67c217309bd7578534980300e61e0ad7d7017fb82c8255ba0c1d87',
  '87fbc37fb26d2779f33002e22c0cfbd39ff9900f267bcff631ad8f0137dd3b87',
  'f83c0db9ef5fbd3cf0102383b45fa692895e41f2ff798ff350374bf97944250e',
  '5a87ea750f91751d73e009ac3e1302136474d8f79c2e1317f76f48b40f7c2a9d',
  'b78850f43c67c217309bd7578534980300e61e0ad7d7017fb82c8255ba0c1d87',
  '221571a64437c6e7f7e0dea2c6436616d04bb274ff76df489e8a6aed14454575',
  '9b8bfc62030313888a6b985c26ac537dce5d8b7a73c2f2df867b27a912e9ce5a',
  'f83c0db9ef5fbd3cf0102383b45fa692895e41f2ff798ff350374bf97944250e',
  '5a87ea750f91751d73e009ac3e1302136474d8f79c2e1317f76f48b40f7c2a9d',
  '221571a64437c6e7f7e0dea2c6436616d04bb274ff76df489e8a6aed14454575',
  '9a1ad1639fae1bda29b0ed85b3e41706de4440b4ded3e221e98a4975849b84b6',
  '0b639a17c9d8f21256be0baa232249293d18002692a7dc5160709591a4cf3913',
  'ad9dc2a241de46f6623c2b612635443b4b4f08090beb6069955123eb05147bae',
  'f2ff96fd1c57c9cdc10d2eb2db69046866fe48768f972d8ce3e7293af533a376',
  '9a1ad1639fae1bda29b0ed85b3e41706de4440b4ded3e221e98a4975849b84b6',
];

it('preserves all 25 reference hashes for large people exports and mapping variants', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-10-22T12:00:00Z');
  await createFactories(database)('gyms', gymId);
  const actor = { gymId, actor: { kind: 'system' } } as const;
  const uploads = new FakeUploads(gymId, clock);
  const pipeline = createImportPipeline({ uploadsFor: async () => uploads, jobs: new FakeJobs(clock), scope: database.forGym, clock });
  const mixed = richPeople(100_000);
  const seedCsv = mixed.seed.split('\n').filter((line, i) => i === 0 || seedMembers.has(Number(/^S(\d+),/.exec(line)?.[1]))).join('\n');
  const seed = await pipeline.upload(actor, new File([seedCsv], 'seed.csv'));
  const run = await pipeline.start(actor, { uploadId: seed.id, mapper: 'people', duplicatePolicy: 'error', dryRun: false,
    mapping: autoMatch(parseCsv(seedCsv).columns).filter(item => item.targetField !== 'medicalNotes') }, 'UTC');
  await pipeline.run(gymId, run.id);
  expect(await pipeline.get(gymId, run.id)).toMatchObject({ status: 'succeeded', committedRows: 616, totalRows: 616 });
  const labels = new Map<string, string>();
  await database.forGym(gymId, async tx => {
    (await tx.select({ id: members.id }).from(members).orderBy(asc(members.id))).forEach((row, i) => labels.set(row.id, 'member#' + i));
    (await tx.select({ id: households.id }).from(households).orderBy(asc(households.id))).forEach((row, i) => labels.set(row.id, 'household#' + i));
  });
  const label = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, id => labels.get(id) ?? 'unknown-id');
  const without = (mapping: ImportColumnMapping[], ...fields: string[]) => mapping.filter(item => !fields.includes(item.targetField));
  const inputs = [familyExport, minimalExport, mixed.csv, richPeople(100_000, 'dmy').csv, richPeople(3000).csv];
  const digests: string[] = [];
  for (const text of inputs) {
    const mapping = autoMatch(parseCsv(text).columns);
    const variants: [ImportColumnMapping[], boolean][] = [[without(mapping, 'medicalNotes'), false], [mapping, false],
      [without(mapping, 'medicalNotes', 'dateOfBirth', 'householdExternalId'), false],
      [mapping.filter(item => ['firstName', 'lastName', 'email'].includes(item.targetField)), false], [without(mapping, 'medicalNotes'), true]];
    for (const [planMapping, reverse] of variants) {
      const rows = parseCsv(text).rows;
      const plan: ImportPlanRequest = { uploadId: uuidv7(), mapper: 'people', duplicatePolicy: 'error', mapping: planMapping };
      const context: MapperContext = { ...actor, clock, runId: 'hash', timezone: 'UTC', sourceRows: rows };
      const starts = Array.from({ length: Math.ceil(rows.length / IMPORT_CHUNK_SIZE) }, (_, i) => i * IMPORT_CHUNK_SIZE);
      if (reverse) starts.reverse();
      const outputs = new Map<number, string>();
      for (const start of starts) {
        const planned = await database.forGym(gymId, tx => peopleMapper.analyze(tx, rows.slice(start, start + IMPORT_CHUNK_SIZE), plan, context));
        outputs.set(start, label(JSON.stringify(planned)));
      }
      const hash = createHash('sha256');
      for (const start of [...outputs.keys()].sort((a, b) => a - b)) hash.update(outputs.get(start)!);
      const digest = hash.digest('hex');
      expect(digest, 'reference plan ' + (digests.length + 1)).toBe(expected[digests.length]);
      digests.push(digest);
    }
  }
  const aggregate = createHash('sha256');
  for (const digest of digests) aggregate.update(digest);
  expect(digests).toHaveLength(25);
  expect(aggregate.digest('hex')).toBe('4d56dd54b50f75724b0bf19998037ec3fbdc2646a2532c3120a011d285f924a7');
}, 600_000);
