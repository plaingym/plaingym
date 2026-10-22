// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { idSchema, instantSchema, paginationSchema, listResponseSchema } from './common.js';
import type { RoutePermission } from '../permissions.js';

// Importing can rewrite a roster and stored billing identifiers: managers only.
const manage = { kind: 'staff', capability: 'settings.manage' } as const satisfies RoutePermission;
const exportPermission = { kind: 'staff', capability: 'data.export' } as const satisfies RoutePermission;
const count = z.int().nonnegative();
const rowNumber = z.int().positive();
const params = z.strictObject({ id: idSchema });
export const importMapperSchema = z.enum(['people', 'mat', 'memberships']);
export const importTargetFieldSchema = z.enum([
  'externalId', 'firstName', 'lastName', 'email', 'dateOfBirth', 'status', 'phone',
  'householdExternalId', 'householdName', 'billingDay', 'emailOptOut', 'tags', 'medicalNotes', 'emergencyContacts',
  'stripeCustomerId', 'stripePaymentMethodId', 'program', 'rank', 'subRank', 'promotedAt',
  'occurredAt', 'classTags', 'plan', 'amountCents', 'currency', 'interval', 'nextDueOn', 'commitmentEndsOn',
]);
export const importColumnMappingSchema = z.strictObject({ sourceColumn: z.string().min(1), targetField: importTargetFieldSchema });
export const importMappingSchema = z.array(importColumnMappingSchema).min(1).refine(
  (items) => new Set(items.map((item) => item.targetField)).size === items.length,
  'Map each target field once',
);
export const uploadCsvRequestSchema = z.strictObject({ file: z.file().min(1).max(20 * 1024 * 1024) });
const csvCell = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const importPreviewRowSchema = z.strictObject({
  rowNumber, values: z.record(z.string(), csvCell),
  action: z.enum(['create', 'update', 'skip', 'error']),
  duplicateIds: z.array(idSchema),
});
/** Upload IDs refer to immutable storage; job IDs refer to the pipeline's jobs. */
export const importUploadSchema = z.strictObject({
  id: idSchema, filename: z.string().min(1), rowCount: count, columns: z.array(z.string().min(1)).min(1),
  suggestedMapping: importMappingSchema.nullable(), expiresAt: instantSchema,
});
export const importPlanRequestSchema = z.strictObject({
  uploadId: idSchema, mapper: importMapperSchema, mapping: importMappingSchema,
  duplicatePolicy: z.enum(['error', 'skip', 'update']),
});
export const importIssueSchema = z.strictObject({
  rowNumber, column: z.string().nullable(),
  code: z.enum(['invalid_value', 'missing_required', 'duplicate', 'unknown_reference', 'currency_mismatch', 'conflict']),
  message: z.string().min(1),
});
export const importPreviewResponseSchema = listResponseSchema(importPreviewRowSchema).extend({
  summary: z.strictObject({ totalRows: count, create: count, update: count, skip: count, errors: count }),
});
export const importJobSchema = z.strictObject({
  id: idSchema, uploadId: idSchema, mapper: importMapperSchema, dryRun: z.boolean(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  totalRows: count, processedRows: count, committedRows: count, errorCount: count,
  createdAt: instantSchema, completedAt: instantSchema.nullable(),
}).refine((value) => value.processedRows <= value.totalRows && value.committedRows <= value.processedRows,
  'Import counters are inconsistent')
  .refine((value) => !value.dryRun || value.committedRows === 0, 'A dry run cannot commit rows');
export const startImportRequestSchema = importPlanRequestSchema.extend({ dryRun: z.boolean() });
/** All gym-owned tables; system tables and auth records have no export selector. */
export const exportDatasets = [
  'staff_roles', 'staff_profiles', 'households', 'members', 'household_users', 'member_tags', 'member_tag_links',
  'installed_packs', 'rank_systems', 'programs', 'ranks', 'member_ranks', 'class_tags', 'class_templates',
  'class_template_programs', 'class_template_tags', 'class_sessions', 'class_session_programs', 'class_session_tags',
  'attendances', 'class_bookings', 'tax_rates', 'plans', 'plan_tax_rates', 'charge_types', 'charge_type_tax_rates',
  'memberships', 'invoices', 'invoice_sequences', 'invoice_line_items', 'payment_methods', 'payment_attempts',
  'payments', 'refunds', 'waiver_templates', 'waiver_signatures', 'kiosk_devices', 'link_campaigns', 'signed_links',
  'audit_events', 'email_outbox',
] as const;
export const exportDatasetSchema = z.enum(exportDatasets);
export const createExportRequestSchema = z.strictObject({ format: z.literal('csv') });
export const exportJobSchema = z.strictObject({
  id: idSchema, status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  datasets: z.array(exportDatasetSchema).length(exportDatasets.length).refine(
    (items) => new Set(items).size === exportDatasets.length, 'Export every gym-owned dataset once',
  ),
  createdAt: instantSchema, completedAt: instantSchema.nullable(),
  downloadUrl: z.url({ protocol: /^https?$/ }).nullable(), expiresAt: instantSchema.nullable(),
}).refine((value) => value.status === 'succeeded'
  ? value.downloadUrl !== null && value.expiresAt !== null && value.completedAt !== null
  : value.downloadUrl === null && value.expiresAt === null,
'Only a finished export has an expiring download');
export const importsContracts = {
  upload: { method: 'post', path: '/api/imports/uploads', permission: manage,
    contentType: 'multipart/form-data', body: uploadCsvRequestSchema, response: z.strictObject({ data: importUploadSchema }) },
  preview: { method: 'post', path: '/api/imports/preview', permission: manage,
    query: paginationSchema, body: importPlanRequestSchema, response: importPreviewResponseSchema },
  start: { method: 'post', path: '/api/imports', permission: manage,
    body: startImportRequestSchema, response: z.strictObject({ data: importJobSchema }) },
  get: { method: 'get', path: '/api/imports/{id}', permission: manage,
    params, response: z.strictObject({ data: importJobSchema }) },
  errors: { method: 'get', path: '/api/imports/{id}/errors', permission: manage,
    params, query: paginationSchema, response: listResponseSchema(importIssueSchema) },
  createExport: { method: 'post', path: '/api/exports', permission: exportPermission,
    body: createExportRequestSchema, response: z.strictObject({ data: exportJobSchema }) },
  getExport: { method: 'get', path: '/api/exports/{id}', permission: exportPermission,
    params, response: z.strictObject({ data: exportJobSchema }) },
} as const satisfies Record<string, EndpointContract>;

export type ImportMapper = z.infer<typeof importMapperSchema>;
export type ImportTargetField = z.infer<typeof importTargetFieldSchema>;
export type ImportColumnMapping = z.infer<typeof importColumnMappingSchema>;
export type ImportUpload = z.infer<typeof importUploadSchema>;
export type ImportPlanRequest = z.infer<typeof importPlanRequestSchema>;
export type ImportPreviewRow = z.infer<typeof importPreviewRowSchema>;
export type ImportPreviewResponse = z.infer<typeof importPreviewResponseSchema>;
export type ImportIssue = z.infer<typeof importIssueSchema>;
export type ImportJob = z.infer<typeof importJobSchema>;
export type StartImportRequest = z.infer<typeof startImportRequestSchema>;
export type ExportDataset = z.infer<typeof exportDatasetSchema>;
export type CreateExportRequest = z.infer<typeof createExportRequestSchema>;
export type ExportJob = z.infer<typeof exportJobSchema>;
