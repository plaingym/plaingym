// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { dateSchema, idSchema, instantSchema, revisionSchema } from './common.js';
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
/** The last automatic patch update attempt. `skipped` changed nothing; the tile's message says why. */
export const automaticUpdatesHealthDetailsSchema = z.strictObject({
  enabled: z.boolean(), lastAttemptAt: instantSchema.nullable(),
  result: z.enum(['never_run', 'up_to_date', 'updated', 'rolled_back', 'failed', 'skipped']),
  fromVersion: z.string().min(1).nullable(), toVersion: z.string().min(1).nullable(),
});
export const updateAvailableHealthDetailsSchema = z.strictObject({
  currentVersion: z.string().min(1), latestVersion: z.string().min(1), available: z.boolean(),
  releaseUrl: z.url({ protocol: /^https?$/ }).nullable(),
});
export const updateAvailableHealthTileSchema = z.strictObject({ ...common, id: z.literal('update_available'), details: updateAvailableHealthDetailsSchema.nullable() });
export const healthTileSchema = z.discriminatedUnion('id', [
  z.strictObject({ ...common, id: z.literal('last_backup'), details: backupHealthDetailsSchema.nullable() }),
  z.strictObject({ ...common, id: z.literal('failed_jobs'), details: failedJobsHealthDetailsSchema.nullable() }),
  z.strictObject({ ...common, id: z.literal('smtp'), details: smtpHealthDetailsSchema.nullable() }),
  z.strictObject({ ...common, id: z.literal('disk'), details: diskHealthDetailsSchema.nullable() }),
  z.strictObject({ ...common, id: z.literal('version'), details: versionHealthDetailsSchema.nullable() }),
  z.strictObject({ ...common, id: z.literal('stripe_webhooks'), details: webhookHealthDetailsSchema.nullable() }),
  z.strictObject({ ...common, id: z.literal('last_charge_run'), details: chargeRunHealthDetailsSchema.nullable() }),
  z.strictObject({ ...common, id: z.literal('automatic_updates'), details: automaticUpdatesHealthDetailsSchema.nullable() }),
  updateAvailableHealthTileSchema,
]).refine((value) => value.status !== 'healthy' || (value.details !== null && value.checkedAt !== null),
  'A healthy tile requires a successful check and its details');
export const healthResponseSchema = z.strictObject({ data: z.strictObject({
  generatedAt: instantSchema,
  tiles: z.array(healthTileSchema).length(healthTileIds.length).refine(
    (tiles) => new Set(tiles.map((tile) => tile.id)).size === healthTileIds.length,
    'Include every health tile exactly once',
  ),
}) });
/** Only the release check, for the admin shell's banner: it reads this instead of every tile. */
export const updateAvailableResponseSchema = z.strictObject({
  data: updateAvailableHealthTileSchema.refine((value) => value.status !== 'healthy' || (value.details !== null && value.checkedAt !== null),
    'A healthy tile requires a successful check and its details'),
});
/** Why a charge threw. A stopped run reports every cause but an outage; the list accepts all three. */
export const chargeFailureCauseSchema = z.enum(['provider_outage', 'needs_reconciliation', 'unexpected']);
/** One stopped charge run's invoices that still need staff. `number` is null for an invoice that had none when the run stopped. */
export const chargeFailureReportSchema = z.strictObject({
  runId: idSchema, day: dateSchema, reportedAt: instantSchema,
  failures: z.array(z.strictObject({ invoiceId: idSchema, number: z.int().positive().nullable(), cause: chargeFailureCauseSchema })).min(1),
});
export const chargeFailuresResponseSchema = z.strictObject({ data: z.array(chargeFailureReportSchema) });
/** The most reports one dismissal names: the list holds at most 90 days of reports. */
export const maxDismissedChargeRuns = 500;
/**
 * Name the reports to dismiss: one `runId`, or the `runIds` the list showed. Exactly one form is accepted, so
 * a body that names nothing is refused instead of dismissing every report, including one written after the list loaded.
 */
export const dismissChargeFailuresRequestSchema = z.union([
  z.strictObject({ runId: idSchema }),
  z.strictObject({ runIds: z.array(idSchema).min(1).max(maxDismissedChargeRuns) }),
]);
/** The invoices the dismissed reports still listed; the invoices themselves are unchanged. */
export const dismissChargeFailuresResponseSchema = z.strictObject({ data: z.strictObject({ dismissed: z.array(idSchema) }) });
/**
 * The owner's switch for automatic patch updates (on by default). The install's nightly timer reads it through the
 * app; `available` is false on an install that serves several gyms, where no timer reads it.
 */
export const autoUpdateSettingsSchema = z.strictObject({ enabled: z.boolean(), available: z.boolean(), revision: revisionSchema });
export const autoUpdateSettingsResponseSchema = z.strictObject({ data: autoUpdateSettingsSchema });
export const updateAutoUpdateSettingsRequestSchema = z.strictObject({ enabled: z.boolean(), revision: revisionSchema });
const manageSettings = { kind: 'staff', capability: 'settings.manage' } satisfies RoutePermission;
const manageIntegrations = { kind: 'staff', capability: 'integrations.manage' } satisfies RoutePermission;
/** Owners only, like the email, payment and backup settings. */
export const autoUpdateContracts = {
  get: { method: 'get', path: '/api/health/auto-update', permission: manageIntegrations, response: autoUpdateSettingsResponseSchema },
  update: { method: 'put', path: '/api/health/auto-update', permission: manageIntegrations,
    description: 'Turns automatic patch updates on or off. A stale revision answers 409.',
    body: updateAutoUpdateSettingsRequestSchema, response: autoUpdateSettingsResponseSchema },
} as const satisfies Record<string, EndpointContract>;
export const healthContracts = {
  get: { method: 'get', path: '/api/health', permission: manageSettings, response: healthResponseSchema },
  getUpdate: { method: 'get', path: '/api/health/update', permission: manageSettings, response: updateAvailableResponseSchema },
  listChargeFailures: { method: 'get', path: '/api/health/charge-failures', permission: manageSettings,
    response: chargeFailuresResponseSchema },
  dismissChargeFailures: { method: 'post', path: '/api/health/charge-failures/dismiss', permission: manageSettings,
    body: dismissChargeFailuresRequestSchema, response: dismissChargeFailuresResponseSchema },
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
export type ChargeFailureCause = z.infer<typeof chargeFailureCauseSchema>;
export type ChargeFailureReport = z.infer<typeof chargeFailureReportSchema>;
export type ChargeRunHealthDetails = z.infer<typeof chargeRunHealthDetailsSchema>;
export type AutomaticUpdatesHealthDetails = z.infer<typeof automaticUpdatesHealthDetailsSchema>;
export type UpdateAvailableHealthDetails = z.infer<typeof updateAvailableHealthDetailsSchema>;
export type AutoUpdateSettings = z.infer<typeof autoUpdateSettingsSchema>;
export type UpdateAutoUpdateSettingsRequest = z.infer<typeof updateAutoUpdateSettingsRequestSchema>;
