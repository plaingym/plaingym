// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { canStaff, isRoutePermission, staffRoles } from '../permissions.js';
import {
  integrationsContracts, integrationsSchema, saveEmailIntegrationRequestSchema, saveStripeIntegrationRequestSchema,
  createBackupKeyRequestSchema, createBackupKeyResponseSchema, confirmBackupKeyRequestSchema, removeEmailIntegrationRequestSchema,
  googleLoginSchema, saveGoogleLoginRequestSchema,
} from './index.js';

const signIn = { password: false, magicLink: true };
const integrations = {
  email: { source: 'gym', host: 'smtp.example.test', port: 587, security: 'starttls', from: 'desk@example.test',
    signIn, signInAfterSave: signIn, signInAfterRemove: { password: true, magicLink: false }, removeBlocked: true },
  payments: { configured: true, mode: 'test', webhookRegistered: true, accountLocked: true,
    testData: { customers: 2, cards: 1, checkouts: 0, payments: 3, importedCustomers: 1, importedCards: 0 }, importedCustomersOnly: false },
  backups: { configured: true, destination: { endpoint: 'https://s3.example.test', region: 'auto', bucket: 'backups' },
    publicKey: 'age1example', pending: null, retentionBudgetBytes: 8_000_000_000 },
  sandbox: false, revision: 3,
};

describe('integration settings contracts', () => {
  it('lets only owners reach every route, under /api/settings/integrations', () => {
    for (const contract of Object.values(integrationsContracts)) {
      expect(isRoutePermission(contract.permission)).toBe(true);
      expect(contract.path.startsWith('/api/settings/integrations')).toBe(true);
      for (const role of staffRoles) expect(canStaff([role], contract.permission.kind === 'staff' ? contract.permission.capability : 'settings.manage')).toBe(role === 'owner');
    }
  });
  it('has no field for a credential in what it returns', () => {
    expect(integrationsSchema.parse(integrations)).toEqual(integrations);
    expect(integrationsSchema.parse({ ...integrations, backups: null }).backups).toBeNull();
    expect(integrationsSchema.parse({ ...integrations, payments: { ...integrations.payments, testData: null } }).payments.testData).toBeNull();
    for (const testData of [{ ...integrations.payments.testData, customers: -1 }, { ...integrations.payments.testData, apiKey: 'secret' }])
      expect(integrationsSchema.safeParse({ ...integrations, payments: { ...integrations.payments, testData } }).success).toBe(false);
    for (const field of ['password', 'username', 'apiKey', 'restrictedKey', 'webhookSecret', 'accessKeyId', 'secretAccessKey', 'privateKey']) {
      expect(integrationsSchema.safeParse({ ...integrations, email: { ...integrations.email, [field]: 'secret' } }).success, field).toBe(false);
      expect(integrationsSchema.safeParse({ ...integrations, payments: { ...integrations.payments, [field]: 'secret' } }).success, field).toBe(false);
      expect(integrationsSchema.safeParse({ ...integrations, backups: { ...integrations.backups, [field]: 'secret' } }).success, field).toBe(false);
    }
    // Only key creation shows the new private key, once.
    expect(createBackupKeyResponseSchema.safeParse({ data: { privateKey: 'AGE-SECRET-KEY-1EXAMPLE', publicKey: 'age1example', integrations } }).success).toBe(true);
  });
  it('returns Google sign-in without its client secret and takes both values on a save', () => {
    const google = { source: 'gym', editable: true, clientId: 'client.apps.googleusercontent.com', clientSecretSet: true, removeBlocked: false, revision: 4 };
    expect(googleLoginSchema.parse(google)).toEqual(google);
    expect(googleLoginSchema.safeParse({ ...google, clientSecret: 'secret' }).success).toBe(false);
    expect(saveGoogleLoginRequestSchema.parse({ revision: 1, clientId: ' id ', clientSecret: 'secret' })).toEqual({ revision: 1, clientId: 'id', clientSecret: 'secret' });
    for (const values of [{ clientId: 'id' }, { clientId: 'an id', clientSecret: 'secret' }, { clientId: 'id', clientSecret: 'x'.repeat(513) }, { clientId: '', clientSecret: 'secret' }])
      expect(saveGoogleLoginRequestSchema.safeParse({ revision: 1, ...values }).success).toBe(false);
  });
  it('validates the requests that carry credentials', () => {
    const email = { revision: 1, host: 'smtp.example.test', username: 'user', password: 'secret', from: 'desk@example.test', testTo: 'owner@example.test' };
    expect(saveEmailIntegrationRequestSchema.parse(email)).toMatchObject({ port: 587, secure: false });
    expect(saveEmailIntegrationRequestSchema.safeParse({ ...email, testTo: undefined }).success).toBe(false);
    expect(removeEmailIntegrationRequestSchema.safeParse({}).success).toBe(false);
    for (const restrictedKey of ['rk_test_abc', 'rk_live_abc']) expect(saveStripeIntegrationRequestSchema.safeParse({ revision: 1, restrictedKey }).success).toBe(true);
    // The switch from test to live is confirmed explicitly; without the field nothing is cleared.
    expect(saveStripeIntegrationRequestSchema.parse({ revision: 1, restrictedKey: 'rk_live_abc' }).clearTestData).toBe(false);
    expect(saveStripeIntegrationRequestSchema.parse({ revision: 1, restrictedKey: 'rk_live_abc', clearTestData: true }).clearTestData).toBe(true);
    expect(saveStripeIntegrationRequestSchema.safeParse({ revision: 1, restrictedKey: 'rk_live_abc', clearTestData: 'yes' }).success).toBe(false);
    for (const restrictedKey of ['sk_test_abc', 'pk_live_abc', 'rk_test_']) expect(saveStripeIntegrationRequestSchema.safeParse({ revision: 1, restrictedKey }).success).toBe(false);
    const destination = { endpoint: 'https://s3.example.test', region: 'auto', bucket: 'backups', accessKeyId: 'id', secretAccessKey: 'secret' };
    expect(createBackupKeyRequestSchema.safeParse({ revision: 1, destination }).success).toBe(true);
    expect(createBackupKeyRequestSchema.safeParse({ revision: 1, destination: { ...destination, endpoint: 'ftp://s3.example.test' } }).success).toBe(false);
    expect(confirmBackupKeyRequestSchema.safeParse({ revision: 1, privateKey: 'age1example' }).success).toBe(false);
  });
});
