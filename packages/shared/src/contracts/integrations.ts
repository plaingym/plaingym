// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { revisionSchema } from './common.js';
import type { RoutePermission } from '../permissions.js';
import { setupS3CredentialsSchema } from './setup.js';

/** Email, Stripe and backups after setup: owners only, like the setup steps that first configure them. */
const own = { kind: 'staff', capability: 'integrations.manage' } as const satisfies RoutePermission;
const recipientSchema = z.string().regex(/^age1[0-9a-z]+$/);
const privateKeySchema = z.string().regex(/^AGE-SECRET-KEY-1[0-9A-Z]+$/);

/** How people sign in to this gym: email links need SMTP (the gym's or the install's), passwords follow `AUTH_PASSWORD_LOGIN`. */
export const signInMethodsSchema = z.strictObject({ password: z.boolean(), magicLink: z.boolean() });
/**
 * What the gym sends email through. `host`, `port`, `security` and `from` describe the gym's own settings and are null
 * otherwise; the SMTP password is never returned. `signInAfterSave` and `signInAfterRemove` are the sign-in methods after
 * saving the gym's own settings or removing them (null when the gym has none to remove). `removeBlocked` is true when
 * removing them would leave the signed-in owner no way to sign in (no email links and no password of their own).
 */
export const emailIntegrationSchema = z.strictObject({
  source: z.enum(['gym', 'install', 'none']),
  host: z.string().nullable(), port: z.int32().min(1).max(65535).nullable(),
  security: z.enum(['starttls', 'tls', 'plain']).nullable(), from: z.string().nullable(),
  signIn: signInMethodsSchema, signInAfterSave: signInMethodsSchema, signInAfterRemove: signInMethodsSchema.nullable(),
  removeBlocked: z.boolean(),
});
/**
 * The gym's Stripe settings, never the key or the webhook signing secret. `accountLocked` is true once a household has a
 * Stripe customer, a card is saved or a card payment exists: a replacement key must then belong to the same Stripe
 * account and mode.
 */
export const paymentsIntegrationSchema = z.strictObject({
  configured: z.boolean(), mode: z.enum(['test', 'live']).nullable(), webhookRegistered: z.boolean(), accountLocked: z.boolean(),
});
export const backupDestinationSchema = setupS3CredentialsSchema.omit({ accessKeyId: true, secretAccessKey: true });
/**
 * Single-gym installs only (null in multi-gym mode). `destination` and `publicKey` are what snapshots use now; `pending`
 * is a new destination and key waiting for the owner to prove they saved the private key, and isn't used until then.
 * Storage credentials and private keys are never returned.
 */
export const backupsIntegrationSchema = z.strictObject({
  configured: z.boolean(), destination: backupDestinationSchema.nullable(), publicKey: recipientSchema.nullable(),
  pending: z.strictObject({ destination: backupDestinationSchema, publicKey: recipientSchema }).nullable(),
  retentionBudgetBytes: z.int().nonnegative(),
});
/** `sandbox` is true in demo mode, where email and payments are the demo's own and nothing here can change. */
export const integrationsSchema = z.strictObject({
  email: emailIntegrationSchema, payments: paymentsIntegrationSchema, backups: backupsIntegrationSchema.nullable(),
  sandbox: z.boolean(), revision: revisionSchema,
});
export const integrationsResponseSchema = z.strictObject({ data: integrationsSchema });

// Credential request objects are deliberately separate from every response.
/** Saved only after the test message to `testTo` is accepted. */
export const saveEmailIntegrationRequestSchema = z.strictObject({
  revision: revisionSchema, host: z.string().trim().min(1), port: z.int32().min(1).max(65535).default(587),
  secure: z.boolean().default(false), username: z.string().min(1), password: z.string().min(1),
  from: z.email(), testTo: z.email(),
});
/** `failed` saves nothing: the integrations are returned unchanged, with the same revision. */
export const saveEmailIntegrationResponseSchema = z.strictObject({ data: z.strictObject({
  test: z.enum(['sent', 'failed']), integrations: integrationsSchema,
}) });
export const removeEmailIntegrationRequestSchema = z.strictObject({ revision: revisionSchema });
export const saveStripeIntegrationRequestSchema = z.strictObject({
  revision: revisionSchema, restrictedKey: z.string().regex(/^rk_(test|live)_[A-Za-z0-9]+$/),
});
export const createBackupKeyRequestSchema = z.strictObject({
  revision: revisionSchema,
  destination: setupS3CredentialsSchema,
});
/** The only response that reveals the new private key; nothing changes for snapshots until it is confirmed. */
export const createBackupKeyResponseSchema = z.strictObject({ data: z.strictObject({
  privateKey: privateKeySchema, publicKey: recipientSchema, integrations: integrationsSchema,
}) });
export const confirmBackupKeyRequestSchema = z.strictObject({ revision: revisionSchema, privateKey: privateKeySchema });

export const integrationsContracts = {
  get: { method: 'get', path: '/api/settings/integrations', permission: own, response: integrationsResponseSchema },
  saveEmail: { method: 'put', path: '/api/settings/integrations/email', permission: own,
    body: saveEmailIntegrationRequestSchema, response: saveEmailIntegrationResponseSchema },
  removeEmail: { method: 'delete', path: '/api/settings/integrations/email', permission: own,
    body: removeEmailIntegrationRequestSchema, response: integrationsResponseSchema },
  saveStripe: { method: 'put', path: '/api/settings/integrations/stripe', permission: own,
    body: saveStripeIntegrationRequestSchema, response: integrationsResponseSchema },
  createBackupKey: { method: 'post', path: '/api/settings/integrations/backups', permission: own,
    body: createBackupKeyRequestSchema, response: createBackupKeyResponseSchema },
  confirmBackupKey: { method: 'post', path: '/api/settings/integrations/backups/confirm', permission: own,
    body: confirmBackupKeyRequestSchema, response: integrationsResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type Integrations = z.infer<typeof integrationsSchema>;
export type EmailIntegration = z.infer<typeof emailIntegrationSchema>;
export type PaymentsIntegration = z.infer<typeof paymentsIntegrationSchema>;
export type BackupsIntegration = z.infer<typeof backupsIntegrationSchema>;
export type SignInMethods = z.infer<typeof signInMethodsSchema>;
export type SaveEmailIntegrationRequest = z.infer<typeof saveEmailIntegrationRequestSchema>;
export type RemoveEmailIntegrationRequest = z.infer<typeof removeEmailIntegrationRequestSchema>;
export type SaveStripeIntegrationRequest = z.infer<typeof saveStripeIntegrationRequestSchema>;
export type CreateBackupKeyRequest = z.infer<typeof createBackupKeyRequestSchema>;
export type ConfirmBackupKeyRequest = z.infer<typeof confirmBackupKeyRequestSchema>;
