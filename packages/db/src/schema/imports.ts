// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import type { ExportDataset, ImportIssue, StartImportRequest } from '@plaingym/shared/contracts';
import { base, choice, instant, ref, scoped } from './common.js';

const statusValues = ['pending', 'running', 'succeeded', 'failed'] as const;
export const importRuns = pgTable('import_runs', {
  ...base(),
  input: jsonb('input').$type<StartImportRequest>().notNull(),
  actor: jsonb('actor').$type<{ kind: 'user'; userId: string } | { kind: 'system' }>().notNull(),
  timezone: text('timezone').notNull(), dryRun: boolean('dry_run').notNull(),
  status: text('status').$type<typeof statusValues[number]>().notNull().default('pending'),
  totalRows: integer('total_rows').notNull(), processedRows: integer('processed_rows').notNull().default(0),
  committedRows: integer('committed_rows').notNull().default(0), errorCount: integer('error_count').notNull().default(0),
  updatedAt: instant('updated_at').notNull(), completedAt: instant('completed_at'),
}, (t) => [...scoped('import_runs', t),
  index('import_runs_retention_idx').on(t.gymId, t.updatedAt),
  choice('import_runs_status_check', t.status, statusValues),
  check('import_runs_counts_check', sql`${t.totalRows} >= 0 and ${t.processedRows} >= 0 and ${t.processedRows} <= ${t.totalRows}
    and ${t.committedRows} >= 0 and ${t.committedRows} <= ${t.processedRows} and ${t.errorCount} >= 0
    and (not ${t.dryRun} or ${t.committedRows} = 0)`),
]).enableRLS();

export const importChunks = pgTable('import_chunks', {
  ...base(), runId: uuid('run_id').notNull(), position: integer('position').notNull(),
  rowCount: integer('row_count').notNull(), committedRows: integer('committed_rows').notNull().default(0),
  issues: jsonb('issues').$type<ImportIssue[]>().notNull().default([]), completedAt: instant('completed_at'),
}, (t) => [...scoped('import_chunks', t),
  ref('import_chunks_run_fk', t.gymId, t.runId, importRuns),
  unique('import_chunks_position_key').on(t.gymId, t.runId, t.position),
  check('import_chunks_counts_check', sql`${t.position} >= 0 and ${t.rowCount} > 0
    and ${t.committedRows} >= 0 and ${t.committedRows} <= ${t.rowCount}`),
]).enableRLS();

export const exportRuns = pgTable('export_runs', {
  ...base(), status: text('status').$type<typeof statusValues[number]>().notNull().default('pending'),
  datasets: jsonb('datasets').$type<ExportDataset[]>().notNull(),
  updatedAt: instant('updated_at').notNull(), completedAt: instant('completed_at'),
  downloadUrl: text('download_url'), expiresAt: instant('expires_at'),
}, (t) => [...scoped('export_runs', t),
  index('export_runs_retention_idx').on(t.gymId, t.updatedAt),
  choice('export_runs_status_check', t.status, statusValues),
  check('export_runs_result_check', sql`(${t.status} = 'succeeded' and ${t.downloadUrl} is not null
    and ${t.expiresAt} is not null and ${t.completedAt} is not null)
    or (${t.status} <> 'succeeded' and ${t.downloadUrl} is null and ${t.expiresAt} is null)`),
]).enableRLS();
