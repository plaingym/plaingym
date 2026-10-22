// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { instantSchema } from './common.js';
import type { RoutePermission } from '../permissions.js';

/** Every built-in tile is present even while its provider is not configured. */
export const healthTileIds = [
  'last_backup', 'failed_jobs', 'smtp', 'disk', 'version', 'stripe_webhooks',
  'last_charge_run', 'automatic_updates', 'update_available',
] as const;
export const healthTileIdSchema = z.enum(healthTileIds);
export const healthStatusSchema = z.enum(['healthy', 'warning', 'error', 'not_configured', 'unavailable']);
const count = z.int().nonnegative();
const common = { status: healthStatusSchema, checkedAt: instantSchema.nullable(), message: z.string() };
export const backupHealthDetailsSchema = z.strictObject({
  latestRestorableAt: instantSchema.nullable(), ageSeconds: count.nullable(), overdue: z.boolean(),
  retainedBytes: count, retentionBudgetBytes: count, pruningStopped: z.boolean(), keyReminder: z.boolean(),
});
export const failedJobsHealthDetailsSchema = z.strictObject({
  failed: count, pending: count, running: count, oldestFailureAt: instantSchema.nullable(),
});
export const smtpHealthDetailsSchema = z.strictObject({ configured: z.boolean(), lastTestAt: instantSchema.nullable() });
export const diskHealthDetailsSchema = z.strictObject({
  totalBytes: count.positive(), availableBytes: count,
}).refine((value) => value.availableBytes <= value.totalBytes, 'Available space exceeds total space');
export const versionHealthDetailsSchema = z.strictObject({ version: z.string().min(1), sourceUrl: z.url({ protocol: /^https?$/ }) });
export const webhookHealthDetailsSchema = z.strictObject({
  lastReceivedAt: instantSchema.nullable(), lastProcessedAt: instantSchema.nullable(), pending: count, failed: count,
});
export const chargeRunHealthDetailsSchema = z.strictObject({
  lastStartedAt: instantSchema.nullable(), lastCompletedAt: instantSchema.nullable(),
  result: z.enum(['never_run', 'running', 'succeeded', 'failed']),
  invoicesProcessed: count, failures: count,
});
export const automaticUpdatesHealthDetailsSchema = z.strictObject({
  enabled: z.boolean(), lastAttemptAt: instantSchema.nullable(),
  result: z.enum(['never_run', 'up_to_date', 'updated', 'rolled_back', 'failed']),
  fromVersion: z.string().min(1).nullable(), toVersion: z.string().min(1).nullable(),
});
export const updateAvailableHealthDetailsSchema = z.strictObject({
  currentVersion: z.string().min(1), latestVersion: z.string().min(1), available: z.boolean(),
  releaseUrl: z.url({ protocol: /^https?$/ }).nullable(),
});
export const healthTileSchema = z.discriminatedUnion('id', [
  z.strictObject({ ...common, id: z.literal('last_backup'), details: backupHealthDetailsSchema.nullable() }),
  z.strictObject({ ...common, id: z.literal('failed_jobs'), details: failedJobsHealthDetailsSchema.nullable() }),
  z.strictObject({ ...common, id: z.literal('smtp'), details: smtpHealthDetailsSchema.nullable() }),
  z.strictObject({ ...common, id: z.literal('disk'), details: diskHealthDetailsSchema.nullable() }),
  z.strictObject({ ...common, id: z.literal('version'), details: versionHealthDetailsSchema.nullable() }),
  z.strictObject({ ...common, id: z.literal('stripe_webhooks'), details: webhookHealthDetailsSchema.nullable() }),
  z.strictObject({ ...common, id: z.literal('last_charge_run'), details: chargeRunHealthDetailsSchema.nullable() }),
  z.strictObject({ ...common, id: z.literal('automatic_updates'), details: automaticUpdatesHealthDetailsSchema.nullable() }),
  z.strictObject({ ...common, id: z.literal('update_available'), details: updateAvailableHealthDetailsSchema.nullable() }),
]).refine((value) => value.status !== 'healthy' || (value.details !== null && value.checkedAt !== null),
  'A healthy tile requires a successful check and its details');
export const healthResponseSchema = z.strictObject({ data: z.strictObject({
  generatedAt: instantSchema,
  tiles: z.array(healthTileSchema).length(healthTileIds.length).refine(
    (tiles) => new Set(tiles.map((tile) => tile.id)).size === healthTileIds.length,
    'Include every health tile exactly once',
  ),
}) });
export const healthContracts = {
  get: { method: 'get', path: '/api/health',
    permission: { kind: 'staff', capability: 'settings.manage' } satisfies RoutePermission,
    response: healthResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type HealthTileId = z.infer<typeof healthTileIdSchema>;
export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type HealthTile = z.infer<typeof healthTileSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type BackupHealthDetails = z.infer<typeof backupHealthDetailsSchema>;
export type FailedJobsHealthDetails = z.infer<typeof failedJobsHealthDetailsSchema>;
export type SmtpHealthDetails = z.infer<typeof smtpHealthDetailsSchema>;
export type DiskHealthDetails = z.infer<typeof diskHealthDetailsSchema>;
export type WebhookHealthDetails = z.infer<typeof webhookHealthDetailsSchema>;
export type ChargeRunHealthDetails = z.infer<typeof chargeRunHealthDetailsSchema>;
export type AutomaticUpdatesHealthDetails = z.infer<typeof automaticUpdatesHealthDetailsSchema>;
export type UpdateAvailableHealthDetails = z.infer<typeof updateAvailableHealthDetailsSchema>;
