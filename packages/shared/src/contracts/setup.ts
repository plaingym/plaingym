// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { currencySchema, idSchema, revisionSchema } from './common.js';
import { gymAddressSchema } from './settings.js';

export const setupStepSchema = z.int32().min(0).max(8);
export const setupTimezoneSchema = z.string().regex(/^(UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/)
  .refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
    catch { return false; }
  }, 'Expected an IANA timezone');
export const setupStatusResponseSchema = z.strictObject({ data: z.strictObject({
  currentStep: setupStepSchema, completedSteps: z.array(setupStepSchema), completed: z.boolean(), revision: revisionSchema,
}) });
export const setupStartRequestSchema = z.strictObject({ choice: z.literal('fresh') });
export const setupOwnerRequestSchema = z.strictObject({
  name: z.string().trim().min(1), email: z.email().toLowerCase(), password: z.string().min(12).max(128),
});
export const setupOwnerResponseSchema = z.strictObject({ data: z.strictObject({ userId: idSchema }) });
export const setupGymDetailsSchema = z.strictObject({
  name: z.string().trim().min(1), timezone: setupTimezoneSchema,
  address: gymAddressSchema, currency: currencySchema,
  branding: z.strictObject({ logoKey: z.string().nullable(), primaryColor: z.string().regex(/^#[a-fA-F0-9]{6}$/).nullable() }),
  revision: revisionSchema,
});
// Currency is mandatory at step 2. Once any plan, charge type, membership or
// invoice references it, a change is a conflict, never a silent conversion.
export const setupGymDetailsResponseSchema = z.strictObject({ data: setupGymDetailsSchema });
export const setupPacksRequestSchema = z.strictObject({
  revision: revisionSchema,
  packs: z.array(z.strictObject({ packId: z.string().regex(/^[a-z][a-z0-9-]*$/), version: z.int32().positive() }))
    .refine((v) => new Set(v.map((pack) => pack.packId)).size === v.length, 'Choose each pack once'),
});
export const setupWebsiteRequestSchema = z.discriminatedUnion('websiteEnabled', [
  z.strictObject({ websiteEnabled: z.literal(true), existingSiteUrl: z.null(), revision: revisionSchema }),
  z.strictObject({ websiteEnabled: z.literal(false), existingSiteUrl: z.url({ protocol: /^https?$/ }).nullable(), revision: revisionSchema }),
]);
// Credential request objects are deliberately separate from every response.
export const setupSmtpRequestSchema = z.discriminatedUnion('choice', [
  z.strictObject({ choice: z.literal('skip'), revision: revisionSchema }),
  z.strictObject({
    choice: z.literal('configure'), revision: revisionSchema, host: z.string().trim().min(1),
    port: z.int32().min(1).max(65535).default(587), secure: z.boolean().default(false),
    username: z.string().min(1), password: z.string().min(1), from: z.email(), testTo: z.email(),
  }),
]);
export const setupSmtpResponseSchema = z.strictObject({ data: z.strictObject({
  configured: z.boolean(), test: z.enum(['not_sent', 'sent', 'failed']), revision: revisionSchema,
}) });
export const setupStripeRequestSchema = z.discriminatedUnion('choice', [
  z.strictObject({ choice: z.literal('skip'), revision: revisionSchema }),
  z.strictObject({ choice: z.literal('configure'), revision: revisionSchema, restrictedKey: z.string().regex(/^rk_(test|live)_[A-Za-z0-9]+$/) }),
]);
export const setupStripeResponseSchema = z.strictObject({ data: z.strictObject({
  configured: z.boolean(), mode: z.enum(['test', 'live']).nullable(), webhookRegistered: z.boolean(), revision: revisionSchema,
}) });
export const setupS3CredentialsSchema = z.strictObject({
  endpoint: z.url({ protocol: /^https?$/ }), region: z.string().min(1), bucket: z.string().min(1),
  accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1),
});
export const setupBackupRequestSchema = z.strictObject({
  revision: revisionSchema, destination: setupS3CredentialsSchema,
});
export const setupBackupKeyResponseSchema = z.strictObject({ data: z.strictObject({
  publicKey: z.string().regex(/^age1[0-9a-z]+$/),
  // Only this creation response reveals the key; status and confirmation never do.
  privateKey: z.string().regex(/^AGE-SECRET-KEY-1[0-9A-Z]+$/), revision: revisionSchema,
}) });
export const setupBackupConfirmRequestSchema = z.strictObject({
  revision: revisionSchema, privateKey: z.string().regex(/^AGE-SECRET-KEY-1[0-9A-Z]+$/),
});
export const setupBackupConfirmResponseSchema = z.strictObject({ data: z.strictObject({
  publicKey: z.string().regex(/^age1[0-9a-z]+$/), confirmed: z.literal(true), revision: revisionSchema,
}) });
export const setupRestoreRequestSchema = z.strictObject({
  choice: z.literal('restore'), source: setupS3CredentialsSchema, snapshotPrefix: z.string().min(1),
  privateKey: z.string().regex(/^AGE-SECRET-KEY-1[0-9A-Z]+$/),
});
export const setupRestoreJobParamsSchema = z.strictObject({ jobId: idSchema });
export const setupRestoreResponseSchema = z.strictObject({ data: z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('running'), jobId: idSchema, phase: z.enum(['verifying', 'database', 'secrets', 'uploads', 'reconciling']) }),
  // Restore skips the rest of setup and leaves billing paused for reconciliation.
  z.strictObject({ status: z.literal('restored'), jobId: idSchema, billingEnabled: z.literal(false), next: z.literal('login') }),
  z.strictObject({ status: z.literal('failed'), jobId: idSchema, message: z.string().min(1) }),
]) });
/** Step 8. `skipBackups` defers backups: it follows the payments step and clears any unconfirmed destination. */
export const setupFinishRequestSchema = z.discriminatedUnion('choice', [
  z.strictObject({ choice: z.literal('fresh'), revision: revisionSchema, skipBackups: z.literal(true).optional() }),
  z.strictObject({ choice: z.literal('import'), revision: revisionSchema, importId: idSchema, skipBackups: z.literal(true).optional() }),
]);
export const setupFinishResponseSchema = z.strictObject({ data: z.strictObject({
  completed: z.literal(true), billingEnabled: z.literal(false), memberEmailsEnabled: z.literal(false), revision: revisionSchema,
}) });

type SetupContract = EndpointContract & {
  gate: 'uninitialized_install' | 'setup_owner'; step?: number;
};
// Public bootstrap endpoints require the install-local first-boot guard and are
// unavailable after initialization. Every later step requires the setup owner.
// Services compare revisions atomically and return the shared conflict error.
export const setupContracts = {
  status: { method: 'get', path: '/api/setup', permission: { kind: 'public' }, gate: 'uninitialized_install', response: setupStatusResponseSchema },
  start: { method: 'post', path: '/api/setup/start', permission: { kind: 'public' }, gate: 'uninitialized_install', step: 0, body: setupStartRequestSchema, response: setupStatusResponseSchema },
  restore: { method: 'post', path: '/api/setup/restore', permission: { kind: 'public' }, gate: 'uninitialized_install', step: 0, body: setupRestoreRequestSchema, response: setupRestoreResponseSchema },
  restoreStatus: { method: 'get', path: '/api/setup/restore/{jobId}', permission: { kind: 'public' }, gate: 'uninitialized_install', step: 0, params: setupRestoreJobParamsSchema, response: setupRestoreResponseSchema },
  owner: { method: 'post', path: '/api/setup/owner', permission: { kind: 'public' }, gate: 'uninitialized_install', step: 1, body: setupOwnerRequestSchema, response: setupOwnerResponseSchema },
  gym: { method: 'put', path: '/api/setup/gym', permission: { kind: 'staff', capability: 'integrations.manage' }, gate: 'setup_owner', step: 2, body: setupGymDetailsSchema, response: setupGymDetailsResponseSchema },
  packs: { method: 'post', path: '/api/setup/packs', permission: { kind: 'staff', capability: 'integrations.manage' }, gate: 'setup_owner', step: 3, body: setupPacksRequestSchema, response: setupStatusResponseSchema },
  website: { method: 'put', path: '/api/setup/website', permission: { kind: 'staff', capability: 'integrations.manage' }, gate: 'setup_owner', step: 4, body: setupWebsiteRequestSchema, response: setupStatusResponseSchema },
  smtp: { method: 'put', path: '/api/setup/smtp', permission: { kind: 'staff', capability: 'integrations.manage' }, gate: 'setup_owner', step: 5, body: setupSmtpRequestSchema, response: setupSmtpResponseSchema },
  stripe: { method: 'put', path: '/api/setup/stripe', permission: { kind: 'staff', capability: 'integrations.manage' }, gate: 'setup_owner', step: 6, body: setupStripeRequestSchema, response: setupStripeResponseSchema },
  backups: { method: 'post', path: '/api/setup/backups', permission: { kind: 'staff', capability: 'integrations.manage' }, gate: 'setup_owner', step: 7, body: setupBackupRequestSchema, response: setupBackupKeyResponseSchema },
  confirmBackupKey: { method: 'post', path: '/api/setup/backups/confirm', permission: { kind: 'staff', capability: 'integrations.manage' }, gate: 'setup_owner', step: 7, body: setupBackupConfirmRequestSchema, response: setupBackupConfirmResponseSchema },
  finish: { method: 'post', path: '/api/setup/finish', permission: { kind: 'staff', capability: 'integrations.manage' }, gate: 'setup_owner', step: 8, body: setupFinishRequestSchema, response: setupFinishResponseSchema },
} as const satisfies Record<string, SetupContract>;

export type SetupStep = z.infer<typeof setupStepSchema>;
export type SetupStatusResponse = z.infer<typeof setupStatusResponseSchema>;
export type SetupOwnerRequest = z.infer<typeof setupOwnerRequestSchema>;
export type SetupGymDetails = z.infer<typeof setupGymDetailsSchema>;
export type SetupPacksRequest = z.infer<typeof setupPacksRequestSchema>;
export type SetupWebsiteRequest = z.infer<typeof setupWebsiteRequestSchema>;
export type SetupSmtpRequest = z.infer<typeof setupSmtpRequestSchema>;
export type SetupStripeRequest = z.infer<typeof setupStripeRequestSchema>;
export type SetupS3Credentials = z.infer<typeof setupS3CredentialsSchema>;
export type SetupBackupRequest = z.infer<typeof setupBackupRequestSchema>;
export type SetupBackupConfirmRequest = z.infer<typeof setupBackupConfirmRequestSchema>;
export type SetupRestoreRequest = z.infer<typeof setupRestoreRequestSchema>;
export type SetupRestoreResponse = z.infer<typeof setupRestoreResponseSchema>;
export type SetupFinishRequest = z.infer<typeof setupFinishRequestSchema>;
