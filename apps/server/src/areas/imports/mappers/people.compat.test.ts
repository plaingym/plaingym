// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { asc } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
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
import { richPeople } from './people.compat.fixtures.js';
import { referenceSeed } from './people.compat.seed.js';
import { referenceDigests } from './people.compat.reference.js';
import type { MapperContext } from './registry.js';

const database = useTestDatabase(), gymId = uuidv7(), clock = new TestClock('2026-10-22T12:00:00Z');
const actor = { gymId, actor: { kind: 'system' } } as const;
const labels = new Map<string, string>();
const label = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, id => labels.get(id) ?? 'unknown-id');
// Reference chunks group ten mapper batches, bounding the golden fixture while locating a mismatch.
const REFERENCE_CHUNK_SIZE = 1000;
beforeAll(async () => {
  await createFactories(database)('gyms', gymId);
  const uploads = new FakeUploads(gymId, clock);
  const pipeline = createImportPipeline({ uploadsFor: async () => uploads, jobs: new FakeJobs(clock), scope: database.forGym, clock });
  const seed = await pipeline.upload(actor, new File([referenceSeed], 'seed.csv'));
  const run = await pipeline.start(actor, { uploadId: seed.id, mapper: 'people', duplicatePolicy: 'error', dryRun: false,
    mapping: autoMatch(parseCsv(referenceSeed).columns).filter(item => item.targetField !== 'medicalNotes') }, 'UTC');
  await pipeline.run(gymId, run.id);
  expect(await pipeline.get(gymId, run.id)).toMatchObject({ status: 'succeeded', committedRows: 616, totalRows: 616 });
  await database.forGym(gymId, async tx => {
    (await tx.select({ id: members.id }).from(members).orderBy(asc(members.id))).forEach((row, i) => labels.set(row.id, 'member#' + i));
    (await tx.select({ id: households.id }).from(households).orderBy(asc(households.id))).forEach((row, i) => labels.set(row.id, 'household#' + i));
  });
});

const inputs = [
  { name: 'family', csv: () => familyExport, large: false },
  { name: 'minimal', csv: () => minimalExport, large: false },
  { name: 'mixed100k', csv: () => richPeople(100_000).csv, large: true },
  { name: 'dmy100k', csv: () => richPeople(100_000, 'dmy').csv, large: true },
  { name: 'mixed3000', csv: () => richPeople(3000).csv, large: false },
];
const without = (mapping: ImportColumnMapping[], ...fields: string[]) => mapping.filter(item => !fields.includes(item.targetField));

for (const input of inputs) it.skipIf(input.large && process.env.PEOPLE_COMPAT_LARGE !== '1')(
  `preserves people reference chunks for ${input.name} under five mapping variants`, async () => {
    const text = input.csv(), mapping = autoMatch(parseCsv(text).columns);
    const variants: [ImportColumnMapping[], boolean][] = [[without(mapping, 'medicalNotes'), false], [mapping, false],
      [without(mapping, 'medicalNotes', 'dateOfBirth', 'householdExternalId'), false],
      [mapping.filter(item => ['firstName', 'lastName', 'email'].includes(item.targetField)), false], [without(mapping, 'medicalNotes'), true]];
    for (const [variant, [planMapping, reverse]] of variants.entries()) {
      const rows = parseCsv(text).rows;
      const plan: ImportPlanRequest = { uploadId: uuidv7(), mapper: 'people', duplicatePolicy: 'error', mapping: planMapping };
      const context: MapperContext = { ...actor, clock, runId: 'hash', timezone: 'UTC', sourceRows: rows };
      const starts = Array.from({ length: Math.ceil(rows.length / IMPORT_CHUNK_SIZE) }, (_, i) => i * IMPORT_CHUNK_SIZE);
      if (reverse) starts.reverse();
      const outputs = new Map<number, string>();
      for (const start of starts) {
        const planned = await database.forGym(gymId, tx => peopleMapper.analyze(tx, rows.slice(start, start + IMPORT_CHUNK_SIZE), plan, context));
        // Keep issue location and code, leaving translated presentation text out of the reference.
        outputs.set(start, label(JSON.stringify(planned.map(row => ({ ...row,
          issues: row.issues.map(({ message: _message, ...issue }) => issue) })))));
      }
      const expected = referenceDigests[`${input.name}:${variant}`]!;
      expect(expected, `reference exists for ${input.name} variant ${variant}`).toBeDefined();
      expect(expected).toHaveLength(Math.ceil(rows.length / REFERENCE_CHUNK_SIZE));
      // Compare in source order even when analysis ran backwards: the first failure names its rows.
      for (let start = 0; start < rows.length; start += REFERENCE_CHUNK_SIZE) {
        const hash = createHash('sha256');
        for (let offset = start; offset < Math.min(start + REFERENCE_CHUNK_SIZE, rows.length); offset += IMPORT_CHUNK_SIZE) hash.update(outputs.get(offset)!);
        expect(hash.digest('hex'), `${input.name} variant ${variant}: first differing chunk, rows ${start + 2}-${Math.min(start + REFERENCE_CHUNK_SIZE, rows.length) + 1}`)
          .toBe(expected[start / REFERENCE_CHUNK_SIZE]);
      }
    }
  }, 600_000);
