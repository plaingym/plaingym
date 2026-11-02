// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { canStaff, isRoutePermission, staffRoles } from '../permissions.js';
import {
  integrationsContracts, integrationsSchema, saveEmailIntegrationRequestSchema, saveStripeIntegrationRequestSchema,
  createBackupKeyRequestSchema, createBackupKeyResponseSchema, confirmBackupKeyRequestSchema, removeEmailIntegrationRequestSchema,
} from './index.js';

const signIn = { password: false, magicLink: true };
const integrations = {
  email: { source: 'gym', host: 'smtp.example.test', port: 587, security: 'starttls', from: 'desk@example.test',
    signIn, signInAfterSave: signIn, signInAfterRemove: { password: true, magicLink: false }, removeBlocked: true },
  payments: { configured: true, mode: 'test', webhookRegistered: true, accountLocked: false },
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
    for (const field of ['password', 'username', 'apiKey', 'restrictedKey', 'webhookSecret', 'accessKeyId', 'secretAccessKey', 'privateKey']) {
      expect(integrationsSchema.safeParse({ ...integrations, email: { ...integrations.email, [field]: 'secret' } }).success, field).toBe(false);
      expect(integrationsSchema.safeParse({ ...integrations, payments: { ...integrations.payments, [field]: 'secret' } }).success, field).toBe(false);
      expect(integrationsSchema.safeParse({ ...integrations, backups: { ...integrations.backups, [field]: 'secret' } }).success, field).toBe(false);
    }
    // Only key creation shows the new private key, once.
    expect(createBackupKeyResponseSchema.safeParse({ data: { privateKey: 'AGE-SECRET-KEY-1EXAMPLE', publicKey: 'age1example', integrations } }).success).toBe(true);
  });
  it('validates the requests that carry credentials', () => {
    const email = { revision: 1, host: 'smtp.example.test', username: 'user', password: 'secret', from: 'desk@example.test', testTo: 'owner@example.test' };
    expect(saveEmailIntegrationRequestSchema.parse(email)).toMatchObject({ port: 587, secure: false });
    expect(saveEmailIntegrationRequestSchema.safeParse({ ...email, testTo: undefined }).success).toBe(false);
    expect(removeEmailIntegrationRequestSchema.safeParse({}).success).toBe(false);
    for (const restrictedKey of ['rk_test_abc', 'rk_live_abc']) expect(saveStripeIntegrationRequestSchema.safeParse({ revision: 1, restrictedKey }).success).toBe(true);
    for (const restrictedKey of ['sk_test_abc', 'pk_live_abc', 'rk_test_']) expect(saveStripeIntegrationRequestSchema.safeParse({ revision: 1, restrictedKey }).success).toBe(false);
    const destination = { endpoint: 'https://s3.example.test', region: 'auto', bucket: 'backups', accessKeyId: 'id', secretAccessKey: 'secret' };
    expect(createBackupKeyRequestSchema.safeParse({ revision: 1, destination }).success).toBe(true);
    expect(createBackupKeyRequestSchema.safeParse({ revision: 1, destination: { ...destination, endpoint: 'ftp://s3.example.test' } }).success).toBe(false);
    expect(confirmBackupKeyRequestSchema.safeParse({ revision: 1, privateKey: 'age1example' }).success).toBe(false);
  });
});
