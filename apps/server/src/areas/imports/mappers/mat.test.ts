// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { attendances, auditEvents, memberRanks, members, programs, ranks, RevisionConflictError, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { ImportPlanRequest, ImportTargetField } from '@plaingym/shared/contracts';
import { TestClock } from '../../../core/clock.js';
import { FakeJobs } from '../../../infra/jobs/index.js';
import { FakeUploads } from '../../../infra/storage/index.js';
import { createImportPipeline } from '../pipeline.js';
import { createPipelineJobs } from '../pipeline.jobs.js';
import { createServerRegistry } from '../../../core/registry.js';
import { exportCatalog } from '../export.catalog.js';
import { csvLine, type CsvRow } from '../pipeline.csv.js';
import type { MapperContext, PlannedRow } from './registry.js';
import { matMapper } from './mat.js';

const database = useTestDatabase(), factory = createFactories(database);
const gymA = uuidv7(), gymB = uuidv7(), clock = new TestClock('2026-10-22T12:00:00Z');
const columns: ImportTargetField[] = ['externalId', 'email', 'firstName', 'lastName', 'dateOfBirth', 'program', 'rank', 'subRank', 'promotedAt', 'occurredAt', 'classTags'];
const mapping = columns.map((field) => ({ sourceColumn: field, targetField: field }));
type Input = Partial<Record<ImportTargetField, string>>;
const plan = (duplicatePolicy: ImportPlanRequest['duplicatePolicy'] = 'skip'): ImportPlanRequest => ({ uploadId: uuidv7(), mapper: 'mat', mapping, duplicatePolicy });
function context(rows: readonly CsvRow[], gymId = gymA): MapperContext {
  return { gymId, actor: { kind: 'system' }, clock, runId: uuidv7(), timezone: 'UTC', sourceRows: rows };
}
const source = (rows: Input[]): CsvRow[] => rows.map((values, index) => ({ rowNumber: index + 2, values: Object.fromEntries(columns.map((column) => [column, values[column] ?? ''])) }));
async function analyze(input: Input[], gymId = gymA, duplicatePolicy: ImportPlanRequest['duplicatePolicy'] = 'skip') {
  const rows = source(input), ctx = context(rows, gymId);
  const planned = await database.forGym(gymId, (tx) => matMapper.analyze({ select: tx.select.bind(tx) }, rows, plan(duplicatePolicy), ctx));
  return { planned, ctx };
}
const commit = (planned: PlannedRow[], ctx: MapperContext) => database.forGym(ctx.gymId, (tx) => matMapper.commit(tx, planned, ctx));
async function person(gymId = gymA, overrides: Partial<typeof members.$inferInsert> = {}) {
  return factory('members', gymId, { email: uuidv7() + '@example.test', firstName: 'Ari', lastName: 'Student', ...overrides });
}
let programA: typeof programs.$inferSelect, programB: typeof programs.$inferSelect;
let rankA: typeof ranks.$inferSelect, nextRank: typeof ranks.$inferSelect;
beforeAll(async () => {
  await factory('gyms', gymA); await factory('gyms', gymB);
  const systemA = await factory('rankSystems', gymA), systemB = await factory('rankSystems', gymA);
  programA = await factory('programs', gymA, { name: 'Track A', rankSystemId: systemA.id });
  programB = await factory('programs', gymA, { name: 'Track B', rankSystemId: systemB.id });
  rankA = await factory('ranks', gymA, { rankSystemId: systemA.id, name: 'Level 1', position: 0, subRanks: [{ id: 'tip', name: 'First tip' }] });
  nextRank = await factory('ranks', gymA, { rankSystemId: systemA.id, name: 'Level 2', position: 1 });
  await factory('ranks', gymA, { rankSystemId: systemB.id, name: 'Level 1', position: 0 });
});

function services(gymId = gymA) {
  const uploads = new FakeUploads(gymId, clock), jobs = new FakeJobs(clock);
  // Exercise the default mapper registry: no extra runtime registration is needed.
  const pipeline = createImportPipeline({ scope: database.forGym, clock, jobs, uploadsFor: async () => uploads });
  createServerRegistry({ jobs: createPipelineJobs(pipeline) }).registerJobs(jobs, new Set());
  const actor = { gymId, actor: { kind: 'system' } } as const;
  async function upload(rows: Input[]) {
    const data = await pipeline.upload(actor, new File([csvLine(columns) + rows.map((row) => csvLine(columns.map((column) => row[column] ?? ''))).join('')], 'mat.csv'));
    return { ...plan(), uploadId: data.id };
  }
  async function run(input: ImportPlanRequest, dryRun = false, timezone = 'UTC') {
    const job = await pipeline.start(actor, { ...input, dryRun }, timezone);
    await jobs.runNext();
    return pipeline.get(gymId, job.id);
  }
  return { pipeline, actor, upload, run };
}

describe('mat CSV mapper with PostgreSQL', () => {
  it('preview and dry run leave every gym-owned table unchanged', async () => {
    const member = await person(), s = services();
    const input = await s.upload([
      { email: member.email!, program: programA.name, rank: rankA.name, promotedAt: '2024-01-01' },
      { email: member.email!, program: programA.name, occurredAt: '2024-02-01T18:30-08:00' },
    ]);
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      for (const [name, dataset] of Object.entries(exportCatalog)) result[name] = await database.forGym(gymA, (tx) => tx.select().from(dataset.table).orderBy(dataset.table.id));
      return result;
    };
    const before = await snapshot();
    expect((await s.pipeline.preview(s.actor, input, { limit: 50, offset: 0 }, 'UTC')).summary).toMatchObject({ create: 2, errors: 0 });
    expect(await s.run(input, true)).toMatchObject({ status: 'succeeded', committedRows: 0, processedRows: 2 });
    expect(await snapshot()).toEqual(before);
  });

  it('reads offset-free history in the gym timezone the run started with', async () => {
    const member = await person(), s = services();
    const input = await s.upload([
      { email: member.email!, program: programA.name, occurredAt: '2024-07-15T18:00', externalId: 'local-evening' },
      { email: member.email!, program: programA.name, occurredAt: '2024-07-15T18:00Z', externalId: 'explicit-utc' },
    ]);
    expect((await s.pipeline.preview(s.actor, input, { limit: 50, offset: 0 }, 'America/Toronto')).summary).toMatchObject({ create: 2, errors: 0 });
    expect(await s.run(input, false, 'America/Toronto')).toMatchObject({ status: 'succeeded', committedRows: 2 });
    const visits = await database.forGym(gymA, (tx) => tx.select().from(attendances).where(eq(attendances.memberId, member.id)));
    expect(visits.map((visit) => visit.occurredAt.toISOString()).sort()).toEqual(['2024-07-15T18:00:00.000Z', '2024-07-15T22:00:00.000Z']);
  });

  it('imports dates, preserves each program rank system, and audits without personal details', async () => {
    const member = await person(), s = services();
    const input = await s.upload([
      { email: member.email!, program: programA.name, rank: rankA.name, subRank: 'First tip', promotedAt: '2024-01-01' },
      { email: member.email!, program: programB.name, rank: rankA.name, promotedAt: '2024-02-01' },
      { email: member.email!, program: programA.name, occurredAt: '2024-03-01T18:30-08:00' },
      { email: member.email!, program: programA.name, classTags: 'training;Open Mat', occurredAt: '2024-03-02T18:30Z' },
      { email: member.email!, program: 'Open Mat', occurredAt: '2024-03-03' },
    ]);
    const job = await s.run(input);
    expect(job).toMatchObject({ status: 'succeeded', committedRows: 5, errorCount: 0 });
    const promotions = await database.forGym(gymA, (tx) => tx.select().from(memberRanks).where(eq(memberRanks.memberId, member.id)));
    expect(promotions).toEqual(expect.arrayContaining([
      expect.objectContaining({ programId: programA.id, rankSystemId: programA.rankSystemId, rankId: rankA.id, subRank: 1, promotedAt: new Date('2024-01-01Z') }),
      expect.objectContaining({ programId: programB.id, rankSystemId: programB.rankSystemId, subRank: 0, promotedAt: new Date('2024-02-01Z') }),
    ]));
    const visits = await database.forGym(gymA, (tx) => tx.select().from(attendances).where(eq(attendances.memberId, member.id)).orderBy(attendances.occurredAt));
    expect(visits).toHaveLength(3);
    expect(visits[0]).toMatchObject({ source: 'import', sessionId: null, kind: 'class', occurredAt: new Date('2024-03-02T02:30Z') });
    expect(visits[1]).toMatchObject({ kind: 'open_mat', programId: programA.id });
    expect(visits[2]).toMatchObject({ kind: 'open_mat', programId: null });
    const audits = await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.targetId, member.id)));
    expect(audits).toHaveLength(0);
    const domainAudits = await database.forGym(gymA, (tx) => tx.select().from(auditEvents)
      .where(eq(auditEvents.gymId, gymA)));
    const imported = domainAudits.filter((row) => (row.after as { importId?: string } | null)?.importId === job.id);
    expect(imported).toHaveLength(5);
    expect(JSON.stringify(imported)).not.toContain(member.email!);
    expect(JSON.stringify(imported)).not.toContain(member.lastName);
    expect(imported.every((row) => row.occurredAt.getTime() === clock.now().getTime())).toBe(true);
    expect(await s.run(input)).toMatchObject({ status: 'succeeded', committedRows: 0 });
    for (const duplicatePolicy of ['error', 'skip', 'update'] as const) {
      const preview = await s.pipeline.preview(s.actor, { ...input, duplicatePolicy }, { limit: 50, offset: 0 }, 'UTC');
      expect(preview.summary).toMatchObject(duplicatePolicy === 'error' ? { errors: 5 } : { skip: 5, errors: 0 });
    }
  });

  it('keeps distinct source rows at the same instant and deduplicates across uploads and concurrent deliveries', async () => {
    const member = await person(), s = services();
    const rows: Input[] = [
      { externalId: 'visit-' + uuidv7(), email: member.email!, occurredAt: '2024-03-01T12:00Z' },
      { externalId: 'visit-' + uuidv7(), email: member.email!, occurredAt: '2024-03-01T12:00Z' },
      { email: member.email!, program: programA.name, occurredAt: '2024-03-01T12:00Z' },
      { email: member.email!, program: programB.name, occurredAt: '2024-03-01T12:00Z' },
      { externalId: member.id, email: member.email!, occurredAt: '2024-04-01T12:00Z' },
      { externalId: member.id, email: member.email!, occurredAt: '2024-04-02T12:00Z' },
    ];
    const input = await s.upload(rows);
    expect(await s.run(input)).toMatchObject({ status: 'succeeded', committedRows: 6 });
    expect(await s.run(await s.upload([...rows].reverse()))).toMatchObject({ status: 'succeeded', committedRows: 0 });
    const fresh = await person(), batch = await analyze([
      { email: fresh.email!, program: programA.name, rank: rankA.name, promotedAt: '2024-01-01' },
      { email: fresh.email!, occurredAt: '2024-02-01' },
    ]);
    const counts = await Promise.all([commit(batch.planned, batch.ctx), commit(batch.planned, batch.ctx)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('reports an aliased promotion duplicate across chunks without rejecting its first occurrence', async () => {
    const member = await person(gymA, { firstName: uuidv7() }), s = services();
    const input = await s.upload([
      { email: member.email!, program: programA.name, rank: rankA.name, promotedAt: '2024-01-01' },
      ...Array.from({ length: 99 }, (_, i) => ({ email: member.email!, externalId: 'visit-' + i, occurredAt: '2024-02-01' })),
      { firstName: member.firstName, lastName: member.lastName, program: programA.name, rank: rankA.name, promotedAt: '2024-01-01' },
    ]);
    expect((await s.pipeline.preview(s.actor, input, { limit: 50, offset: 0 }, 'UTC')).summary).toMatchObject({ create: 100, errors: 1 });
    expect(await s.run(input, true)).toMatchObject({ status: 'failed', errorCount: 1, committedRows: 0 });
    expect(await s.run(input)).toMatchObject({ status: 'failed', errorCount: 1, committedRows: 100 });
  });

  it('reports within-file duplicates beyond the first 100 rows, including a restarted analysis', async () => {
    const member = await person(), s = services();
    const rows = Array.from({ length: 101 }, (_, index) => ({ email: member.email!, externalId: 'visit-' + index, occurredAt: '2024-03-01' }));
    rows[100] = { ...rows[0]! };
    const input = await s.upload(rows);
    expect((await s.pipeline.preview(s.actor, input, { limit: 50, offset: 0 }, 'UTC')).summary).toMatchObject({ create: 100, errors: 1 });
    const sourceRows = source(rows), ctx = context(sourceRows);
    const restarted = await database.forGym(gymA, (tx) => matMapper.analyze(tx, sourceRows.slice(100), input, ctx));
    expect(restarted[0]!.issues).toEqual([expect.objectContaining({ code: 'duplicate', rowNumber: 102, message: expect.stringContaining('2') })]);
    expect(await s.run(input)).toMatchObject({ committedRows: 100, errorCount: 1 });
  });

  it('checks promotion chronology across chunks in preview, dry run and commit, including member aliases', async () => {
    const member = await person(gymA, { firstName: uuidv7() }), s = services();
    const rows: Input[] = [
      { email: member.email!, program: programA.name, rank: nextRank.name, promotedAt: '2024-01-01' },
      ...Array.from({ length: 99 }, (_, index) => ({ email: member.email!, externalId: `visit-${index}`, occurredAt: '2024-02-01' })),
      { firstName: member.firstName, lastName: member.lastName, program: programA.name, rank: rankA.name, promotedAt: '2024-03-01' },
    ];
    const input = await s.upload(rows);
    expect((await s.pipeline.preview(s.actor, input, { limit: 100, offset: 0 }, 'UTC')).summary).toMatchObject({ errors: 2, create: 99 });
    expect(await s.run(input, true)).toMatchObject({ status: 'failed', errorCount: 2, committedRows: 0 });
    expect(await s.run(input)).toMatchObject({ status: 'failed', errorCount: 2, committedRows: 99 });
    expect(await database.forGym(gymA, (tx) => tx.select().from(memberRanks).where(eq(memberRanks.memberId, member.id)))).toHaveLength(0);
    // Correct the later row to precede the higher rank, then retry with duplicate visits skipped.
    rows[100]!.promotedAt = '2023-01-01';
    const corrected = await s.upload(rows);
    expect(await s.run(corrected, true)).toMatchObject({ status: 'succeeded', errorCount: 0 });
    expect(await s.run(corrected)).toMatchObject({ status: 'succeeded', committedRows: 2 });
    expect(await s.run(corrected)).toMatchObject({ status: 'succeeded', committedRows: 0 });
  });

  it('never matches members, programs or ranks from another gym', async () => {
    const foreign = await person(gymB), local = await person(gymA, { email: foreign.email });
    const system = await factory('rankSystems', gymB);
    const foreignProgram = await factory('programs', gymB, { name: 'Foreign Track', rankSystemId: system.id });
    await factory('ranks', gymB, { name: 'Foreign Rank', rankSystemId: system.id, position: 0 });
    const { planned } = await analyze([
      { email: foreign.email!, occurredAt: '2024-01-01' },
      { email: foreign.email!, program: foreignProgram.name, rank: 'Foreign Rank', promotedAt: '2024-01-01' },
      { email: foreign.email!, program: programA.name, rank: 'Foreign Rank', promotedAt: '2024-01-01' },
    ]);
    expect(planned[0]!.values.memberId).toBe(local.id);
    expect(planned.slice(1).every((row) => row.issues[0]?.code === 'unknown_reference')).toBe(true);
    const onlyForeign = await person(gymB);
    expect((await analyze([{ email: onlyForeign.email!, occurredAt: '2024-01-01' }])).planned[0]!.issues[0]!.code).toBe('unknown_reference');
    const batch = await analyze([{ email: local.email!, occurredAt: '2024-01-01' }]);
    batch.planned[0]!.values.memberId = foreign.id;
    await expect(commit(batch.planned, batch.ctx)).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it('does not treat another gym\'s existing source key as a duplicate', async () => {
    const member = await person();
    const batch = await analyze([{ email: member.email!, externalId: 'shared-visit', occurredAt: '2024-01-01' }]);
    const foreign = await person(gymB);
    await factory('attendances', gymB, { memberId: foreign.id, source: 'import', sourceKey: String(batch.planned[0]!.values.sourceKey) });
    const checked = await analyze([{ email: member.email!, externalId: 'shared-visit', occurredAt: '2024-01-01' }]);
    expect(checked.planned[0]).toMatchObject({ action: 'create', duplicateIds: [], issues: [] });
    expect(await commit(checked.planned, checked.ctx)).toBe(1);
  });

  it('requires unambiguous identities and excludes erased members', async () => {
    const email = uuidv7() + '@example.test';
    const one = await person(gymA, { email, dateOfBirth: '2000-01-01' });
    await person(gymA, { email, dateOfBirth: '2001-01-01' });
    expect((await analyze([{ email, occurredAt: '2024-01-01' }])).planned[0]!.issues[0]!.message).toContain('Several');
    expect((await analyze([{ email: email.toUpperCase(), dateOfBirth: '2000-01-01', occurredAt: '2024-01-01' }])).planned[0]!.values.memberId).toBe(one.id);
    const erased = await person(gymA, { anonymizedAt: clock.now() });
    expect((await analyze([{ email: erased.email!, occurredAt: '2024-01-01' }])).planned[0]!.action).toBe('error');
    const named = await person(gymA, { firstName: 'Name_' + uuidv7(), lastName: 'Percent%Student', email: null });
    expect((await analyze([{ firstName: named.firstName, lastName: named.lastName, occurredAt: '2024-01-01' }])).planned[0]!.values.memberId).toBe(named.id);
  });

  it.each(['member', 'program', 'rank'] as const)('rejects a stale %s revision before writing attendance or promotions', async (changed) => {
    const member = await person(), system = await factory('rankSystems', gymA);
    const program = await factory('programs', gymA, { rankSystemId: system.id });
    const rank = await factory('ranks', gymA, { rankSystemId: system.id, position: 0 });
    const batch = await analyze([
      { email: member.email!, program: program.name, occurredAt: '2024-02-01' },
      { email: member.email!, program: program.name, rank: rank.name, promotedAt: '2024-01-01' },
    ]);
    await database.forGym(gymA, async (tx) => {
      if (changed === 'member') await tx.update(members).set({ revision: member.revision + 1 }).where(eq(members.id, member.id));
      if (changed === 'program') await tx.update(programs).set({ revision: program.revision + 1 }).where(eq(programs.id, program.id));
      if (changed === 'rank') await tx.update(ranks).set({ revision: rank.revision + 1 }).where(eq(ranks.id, rank.id));
    });
    await expect(commit(batch.planned, batch.ctx)).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await database.forGym(gymA, (tx) => tx.select().from(attendances).where(eq(attendances.memberId, member.id)))).toHaveLength(0);
    expect(await database.forGym(gymA, (tx) => tx.select().from(memberRanks).where(eq(memberRanks.memberId, member.id)))).toHaveLength(0);
  });

  it('validates promotion order again after a concurrent promotion', async () => {
    const member = await person();
    const batch = await analyze([{ email: member.email!, program: programA.name, rank: rankA.name, promotedAt: '2024-02-01' }]);
    await factory('memberRanks', gymA, { memberId: member.id, programId: programA.id, rankSystemId: programA.rankSystemId!, rankId: nextRank.id, promotedAt: new Date('2024-01-01Z') });
    await expect(commit(batch.planned, batch.ctx)).rejects.toBeInstanceOf(RevisionConflictError);
    expect((await analyze([{ email: member.email!, program: programA.name, rank: rankA.name, promotedAt: '2024-02-01' }])).planned[0]!.issues[0]!.code).toBe('conflict');
  });

  it('reports row validation failures and refuses oversized commits', async () => {
    const member = await person();
    const batch = await analyze([
      { email: member.email!, program: programA.name, rank: rankA.name, promotedAt: '2024-01-01', occurredAt: '2024-01-02' },
      { email: member.email!, program: programA.name, rank: rankA.name, subRank: '9', promotedAt: '2024-01-01' },
      { email: member.email!, occurredAt: '2024-02-30' },
      { email: member.email!, occurredAt: '2099-01-01' },
      { email: member.email!, program: 'Unknown Track', classTags: 'open mat', occurredAt: '2024-01-01' },
      { occurredAt: '2024-01-01' },
    ]);
    expect(batch.planned.every((row) => row.action === 'error' && row.issues.length > 0)).toBe(true);
    expect(await commit(batch.planned, batch.ctx)).toBe(0);
    await expect(commit(Array.from({ length: 101 }, () => batch.planned[0]!), batch.ctx)).rejects.toThrow('100');
    expect(await database.forGym(gymA, (tx) => tx.select().from(attendances)
      .where(and(eq(attendances.gymId, gymA), eq(attendances.memberId, member.id))))).toHaveLength(0);
  });
});
