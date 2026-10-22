// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { systemTables } from '../../../db/system-tables.mjs';
import type { jobs } from '../../../db/src/schema/index.js';
import {
  importsContracts, importPlanRequestSchema, importJobSchema, importPreviewResponseSchema,
  uploadCsvRequestSchema, exportDatasets, exportDatasetSchema, exportJobSchema, type ImportJob,
} from './index.js';
import { canStaff, staffRoles } from '../permissions.js';

const id = '019a08bf-1234-7000-8000-000000000001';
const now = '2026-10-21T20:00:00Z';
const plan = { uploadId: id, mapper: 'people', mapping: [{ sourceColumn: 'First name', targetField: 'firstName' }], duplicatePolicy: 'error' };
const job = { id, uploadId: id, mapper: 'people', dryRun: true, status: 'succeeded', totalRows: 5000,
  processedRows: 5000, committedRows: 0, errorCount: 0, createdAt: now, completedAt: now };

describe('import and export contracts', () => {
  it('accepts multipart CSV files within the upload size limit', () => {
    expect(uploadCsvRequestSchema.safeParse({ file: new File(['name\nA\n'], 'members.csv', { type: 'text/csv' }) }).success).toBe(true);
    expect(uploadCsvRequestSchema.safeParse({ file: new File([], 'empty.csv') }).success).toBe(false);
    expect(uploadCsvRequestSchema.safeParse({ file: 'file contents' }).success).toBe(false);
    expect(uploadCsvRequestSchema.safeParse({ file: new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'too-large.csv') }).success).toBe(false);
  });
  it('rejects ambiguous mappings and destinations that could overwrite a secret hash', () => {
    expect(importPlanRequestSchema.parse(plan)).toEqual(plan);
    expect(importPlanRequestSchema.safeParse({ ...plan, mapping: [plan.mapping[0], plan.mapping[0]] }).success).toBe(false);
    expect(importPlanRequestSchema.safeParse({ ...plan, mapping: [{ sourceColumn: 'Secret', targetField: 'pinHash' }] }).success).toBe(false);
    expect(importPlanRequestSchema.safeParse({ ...plan, gymId: id }).success).toBe(false);
  });
  it('makes preview pagination, duplicate actions, and summary counts explicit', () => {
    const preview = { data: [{ rowNumber: 2, values: { firstName: 'A' }, action: 'update', duplicateIds: [id] }],
      pagination: { limit: 50, offset: 0, total: 1 }, summary: { totalRows: 1, create: 0, update: 1, skip: 0, errors: 0 } };
    expect(importPreviewResponseSchema.parse(preview)).toEqual(preview);
    expect(importPreviewResponseSchema.safeParse({ ...preview, pagination: { limit: 50, offset: 0 } }).success).toBe(false);
  });
  it('rejects committed dry runs and counters beyond the input size', () => {
    expect(importJobSchema.parse(job)).toEqual(job);
    expect(importJobSchema.safeParse({ ...job, committedRows: 1 }).success).toBe(false);
    expect(importJobSchema.safeParse({ ...job, processedRows: 5001 }).success).toBe(false);
    expect(importJobSchema.safeParse({ ...job, dryRun: false, committedRows: 5001 }).success).toBe(false);
    expectTypeOf<ImportJob['status']>().toExtend<typeof jobs.$inferSelect.status>();
    expectTypeOf<ImportJob['id']>().toEqualTypeOf<typeof jobs.$inferSelect.id>();
  });
  it('covers every locked gym-owned table and excludes the exhaustive system-table inventory', () => {
    // Compare the export manifest with the authoritative schema declarations.
    const schemaDirectory = new URL('../../../db/src/schema/', import.meta.url);
    const tableNames = readdirSync(schemaDirectory).filter((file) => file.endsWith('.ts')).flatMap((file) =>
      [...readFileSync(new URL(file, schemaDirectory), 'utf8').matchAll(/pgTable\('([^']+)'/g)].map((match) => match[1]!),
    );
    const systemNames = new Set(systemTables.map((table) => table.name));
    expect([...exportDatasets].sort()).toEqual(tableNames.filter((name) => !systemNames.has(name)).sort());
    for (const name of systemNames) expect(exportDatasetSchema.safeParse(name).success).toBe(false);
  });
  it('requires all datasets once and gives a download only to a completed export', () => {
    const pending = { id, status: 'pending', datasets: [...exportDatasets], createdAt: now,
      completedAt: null, downloadUrl: null, expiresAt: null };
    expect(exportJobSchema.parse(pending)).toEqual(pending);
    expect(exportJobSchema.safeParse({ ...pending, downloadUrl: 'https://example.com/export' }).success).toBe(false);
    expect(exportJobSchema.safeParse({ ...pending, status: 'succeeded' }).success).toBe(false);
    const complete = { ...pending, status: 'succeeded', completedAt: now,
      downloadUrl: 'https://example.com/export', expiresAt: '2026-10-22T20:00:00Z' };
    expect(exportJobSchema.parse(complete)).toEqual(complete);
    expect(exportJobSchema.safeParse({ ...complete, datasets: exportDatasets.slice(1) }).success).toBe(false);
    expect(exportJobSchema.safeParse({ ...complete, datasets: [...exportDatasets.slice(1), exportDatasets[1]] }).success).toBe(false);
  });
  it.each(Object.entries(importsContracts))('%s permits managers and denies coaches/front desk', (_operation, contract) => {
    for (const role of staffRoles) expect(canStaff([role], contract.permission.capability)).toBe(['owner', 'admin'].includes(role));
  });
});
