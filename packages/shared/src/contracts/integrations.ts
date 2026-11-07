// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { revisionSchema } from './common.js';
import type { RoutePermission } from '../permissions.js';
import { googleClientValueSchema, setupS3CredentialsSchema, setupSmtpRequestSchema, restrictedKeyPattern } from './setup.js';

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
 * removing them would leave the signed-in owner no way to sign in (no email links, no password of their own and no Google client).
 */
export const emailIntegrationSchema = z.strictObject({
  source: z.enum(['gym', 'install', 'none']),
  host: z.string().nullable(), port: z.int32().min(1).max(65535).nullable(),
  security: z.enum(['starttls', 'tls', 'plain']).nullable(), from: z.string().nullable(),
  signIn: signInMethodsSchema, signInAfterSave: signInMethodsSchema, signInAfterRemove: signInMethodsSchema.nullable(),
  removeBlocked: z.boolean(),
});
/**
 * What a switch from test to live clears (`clearTestData`): households holding a Stripe customer the test key made,
 * the cards saved through Stripe, and open Checkout or card-setup sessions. `payments` counts the card payments that stay
 * in the books, marked as test. `importedCustomers` and `importedCards` stay too: an import writes Stripe IDs without
 * asking Stripe, so they may be the gym's live ones.
 */
export const stripeTestDataSchema = z.strictObject({
  customers: z.int().nonnegative(), cards: z.int().nonnegative(), checkouts: z.int().nonnegative(), payments: z.int().nonnegative(),
  importedCustomers: z.int().nonnegative(), importedCards: z.int().nonnegative(),
});
/**
 * The gym's Stripe settings, never the key or the webhook signing secret. `accountLocked` is true once a household has a
 * Stripe customer, a card is saved or a card payment exists: a replacement key must then belong to the same Stripe
 * account and mode, unless the gym switches from test to live with `clearTestData`. `testData` is what that switch
 * would clear, while the gym is in test mode with Stripe customers, cards or payments (null otherwise).
 * `importedCustomersOnly` is true while the gym has no Stripe settings and its only Stripe references are imported
 * customer IDs: any account's key is then accepted, and customers it can't read get new ones when they're first needed.
 */
export const paymentsIntegrationSchema = z.strictObject({
  configured: z.boolean(), mode: z.enum(['test', 'live']).nullable(), webhookRegistered: z.boolean(), accountLocked: z.boolean(),
  testData: stripeTestDataSchema.nullable(), importedCustomersOnly: z.boolean(),
});
/**
 * The `reference` a card payment carries once a switch from test to live has marked it as a test payment. Card payments
 * otherwise never have a reference, so it can't be mistaken for a staff-entered one.
 */
export const stripeTestPaymentReference = 'Stripe test mode';
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
/**
 * `sandbox` is true in demo mode, where email and payments are the demo's own and nothing here can change.
 * `integrationsEditable` is whether the gym's owners may change email and payments: always on a single-gym install; on a
 * multi-gym one, only when the operator allows it. When false, those changes are refused and the sections are read-only.
 */
export const integrationsSchema = z.strictObject({
  email: emailIntegrationSchema, payments: paymentsIntegrationSchema, backups: backupsIntegrationSchema.nullable(),
  sandbox: z.boolean(), integrationsEditable: z.boolean(), revision: revisionSchema,
});
export const integrationsResponseSchema = z.strictObject({ data: integrationsSchema });

// Credential request objects are deliberately separate from every response.
/** Saved only after the test message to `testTo` is accepted. */
export const saveEmailIntegrationRequestSchema = setupSmtpRequestSchema.options[1].omit({ choice: true });
/** `failed` saves nothing: the integrations are returned unchanged, with the same revision. */
export const saveEmailIntegrationResponseSchema = z.strictObject({ data: z.strictObject({
  test: z.enum(['sent', 'failed']), integrations: integrationsSchema,
}) });
export const removeEmailIntegrationRequestSchema = z.strictObject({ revision: revisionSchema });
/**
 * `clearTestData` confirms a switch from a test-mode key to a live one: once the live key connects, the gym's test-mode
 * Stripe references are cleared in one audited change (see `stripeTestDataSchema`). It changes nothing for any other save,
 * and without it that switch is refused (`mode_locked`) while test-mode references exist. Live to test is always refused
 * while live-mode references exist.
 */
export const saveStripeIntegrationRequestSchema = z.strictObject({
  revision: revisionSchema, restrictedKey: z.string().regex(restrictedKeyPattern), clearTestData: z.boolean().default(false),
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

/**
 * Google sign-in for this gym. `source` is `install` when the instance's configuration (`GOOGLE_CLIENT_ID` and
 * `GOOGLE_CLIENT_SECRET`) sets the OAuth client, which then wins; `gym` when the gym's own stored client is used; `none`
 * when Google sign-in is off. `editable` is true only on a single-gym install whose configuration doesn't set Google,
 * outside demo mode: elsewhere there is no form. `clientId` is the stored client's ID (null otherwise); the client
 * secret is write-only and never returned, only whether one is stored. `removeBlocked` is true when removing the stored
 * client would leave the signed-in owner no way to sign in (no email links and no password of their own).
 */
export const googleLoginSchema = z.strictObject({
  source: z.enum(['install', 'gym', 'none']), editable: z.boolean(), clientId: z.string().nullable(), clientSecretSet: z.boolean(),
  /** A stored client cannot be read and may be removed or replaced; it never enables sign-in. */
  unreadable: z.boolean().default(false),
  removeBlocked: z.boolean(), revision: revisionSchema,
});
export const googleLoginResponseSchema = z.strictObject({ data: googleLoginSchema });
/** Replaces the stored client: both values are always sent, so a secret is never kept for another client ID. */
export const saveGoogleLoginRequestSchema = z.strictObject({
  revision: revisionSchema, clientId: googleClientValueSchema, clientSecret: googleClientValueSchema,
});
export const removeGoogleLoginRequestSchema = z.strictObject({ revision: revisionSchema });

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
  getGoogle: { method: 'get', path: '/api/settings/integrations/google', permission: own, response: googleLoginResponseSchema },
  saveGoogle: { method: 'put', path: '/api/settings/integrations/google', permission: own,
    body: saveGoogleLoginRequestSchema, response: googleLoginResponseSchema },
  removeGoogle: { method: 'delete', path: '/api/settings/integrations/google', permission: own,
    body: removeGoogleLoginRequestSchema, response: googleLoginResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type Integrations = z.infer<typeof integrationsSchema>;
export type EmailIntegration = z.infer<typeof emailIntegrationSchema>;
export type PaymentsIntegration = z.infer<typeof paymentsIntegrationSchema>;
export type StripeTestData = z.infer<typeof stripeTestDataSchema>;
export type BackupsIntegration = z.infer<typeof backupsIntegrationSchema>;
export type SignInMethods = z.infer<typeof signInMethodsSchema>;
export type SaveEmailIntegrationRequest = z.infer<typeof saveEmailIntegrationRequestSchema>;
export type RemoveEmailIntegrationRequest = z.infer<typeof removeEmailIntegrationRequestSchema>;
export type SaveStripeIntegrationRequest = z.infer<typeof saveStripeIntegrationRequestSchema>;
export type CreateBackupKeyRequest = z.infer<typeof createBackupKeyRequestSchema>;
export type ConfirmBackupKeyRequest = z.infer<typeof confirmBackupKeyRequestSchema>;
export type GoogleLogin = z.infer<typeof googleLoginSchema>;
export type SaveGoogleLoginRequest = z.infer<typeof saveGoogleLoginRequestSchema>;
export type RemoveGoogleLoginRequest = z.infer<typeof removeGoogleLoginRequestSchema>;
