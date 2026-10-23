// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import { canStaff, isRoutePermission, staffRoles } from '../permissions.js';
import type { gyms } from '../../../db/src/schema/index.js';
import {
  setupContracts, setupGymDetailsSchema, setupWebsiteRequestSchema, setupSmtpRequestSchema,
  setupSmtpResponseSchema, setupStripeRequestSchema, setupStripeResponseSchema,
  setupBackupRequestSchema, setupBackupKeyResponseSchema, setupBackupConfirmRequestSchema,
  setupBackupConfirmResponseSchema, setupRestoreRequestSchema, setupRestoreResponseSchema,
  setupFinishRequestSchema, setupFinishResponseSchema, setupPacksRequestSchema, type SetupGymDetails,
} from './index.js';

const id = '019a08bf-1234-7000-8000-000000000001';
const details = { name: 'Academy', timezone: 'America/Vancouver', address: {}, currency: 'CAD', branding: { logoKey: null, primaryColor: '#123456' }, revision: 1 };
const destination = { endpoint: 'https://s3.example.com', region: 'test', bucket: 'backups', accessKeyId: 'example-access', secretAccessKey: 'example-secret' };
const privateKey = 'AGE-SECRET-KEY-1EXAMPLE';
const publicKey = 'age1example';

describe('setup wizard contracts', () => {
  it('covers every wizard step and guards bootstrap separately from owner steps', () => {
    const steps = new Set<number>();
    for (const contract of Object.values(setupContracts)) {
      expect(isRoutePermission(contract.permission)).toBe(true);
      if ('step' in contract) steps.add(contract.step);
      if (contract.permission.kind === 'public') {
        expect(contract.gate).toBe('uninitialized_install');
      } else {
        expect(contract.gate).toBe('setup_owner');
        for (const role of staffRoles) expect(canStaff([role], contract.permission.capability)).toBe(role === 'owner');
        expect(canStaff([], contract.permission.capability)).toBe(false);
      }
    }
    expect([...steps].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it('requires gym currency and a valid IANA timezone at step 2', () => {
    expect(setupGymDetailsSchema.parse(details)).toEqual(details);
    expect(setupGymDetailsSchema.safeParse({ ...details, currency: undefined }).success).toBe(false);
    for (const timezone of ['Mars/Olympus', 'PST', '+01:00', '']) expect(setupGymDetailsSchema.safeParse({ ...details, timezone }).success).toBe(false);
    for (const timezone of ['UTC', 'Asia/Kolkata', 'Etc/GMT+5']) expect(setupGymDetailsSchema.safeParse({ ...details, timezone }).success).toBe(true);
    for (const revision of [undefined, 0, -1, 1.5, '1']) expect(setupGymDetailsSchema.safeParse({ ...details, revision }).success).toBe(false);
    expect(setupGymDetailsSchema.safeParse({ ...details, currency: 'cad' }).success).toBe(false);
    expectTypeOf<Exclude<keyof SetupGymDetails, keyof typeof gyms.$inferSelect>>().toEqualTypeOf<never>();
    expectTypeOf<Pick<SetupGymDetails, 'name' | 'timezone' | 'currency' | 'revision'>>().toEqualTypeOf<Pick<typeof gyms.$inferSelect, 'name' | 'timezone' | 'currency' | 'revision'>>();
  });
  it('keeps website and content pack choices coherent', () => {
    expect(setupWebsiteRequestSchema.safeParse({ websiteEnabled: true, existingSiteUrl: null, revision: 1 }).success).toBe(true);
    expect(setupWebsiteRequestSchema.safeParse({ websiteEnabled: true, existingSiteUrl: 'https://example.com', revision: 1 }).success).toBe(false);
    expect(setupWebsiteRequestSchema.safeParse({ websiteEnabled: false, existingSiteUrl: 'https://example.com', revision: 1 }).success).toBe(true);
    expect(setupWebsiteRequestSchema.safeParse({ websiteEnabled: false, existingSiteUrl: 'javascript:alert(1)', revision: 1 }).success).toBe(false);
    const pack = { packId: 'training', version: 1 };
    expect(setupPacksRequestSchema.safeParse({ revision: 1, packs: [pack, pack] }).success).toBe(false);
    expect(setupPacksRequestSchema.safeParse({ revision: 1, packs: [] }).success).toBe(true);
  });
  it('allows SMTP/Stripe to be skipped and never returns credentials', () => {
    expect(setupSmtpRequestSchema.safeParse({ choice: 'skip', revision: 1 }).success).toBe(true);
    expect(setupStripeRequestSchema.safeParse({ choice: 'skip', revision: 1 }).success).toBe(true);
    expect(setupSmtpRequestSchema.parse({ choice: 'configure', revision: 1, host: 'smtp.example.com', username: 'example', password: 'example', from: 'gym@example.com', testTo: 'owner@example.com' }).choice).toBe('configure');
    expect(setupStripeRequestSchema.safeParse({ choice: 'configure', revision: 1, restrictedKey: 'rk_test_example' }).success).toBe(true);
    expect(setupStripeRequestSchema.safeParse({ choice: 'configure', revision: 1, restrictedKey: 'sk_live_example' }).success).toBe(false);
    expect(setupStripeResponseSchema.safeParse({ data: { configured: true, mode: 'test', webhookRegistered: true, revision: 2, restrictedKey: 'rk_test_example' } }).success).toBe(false);
    expect(setupSmtpResponseSchema.safeParse({ data: { configured: true, test: 'sent', revision: 2, password: 'secret' } }).success).toBe(false);
  });
  it('reveals a backup private key once and accepts it back only for confirmation', () => {
    expect(setupBackupRequestSchema.safeParse({ revision: 1, destination }).success).toBe(true);
    expect(setupBackupKeyResponseSchema.safeParse({ data: { publicKey, privateKey, revision: 2 } }).success).toBe(true);
    expect(setupBackupConfirmRequestSchema.safeParse({ revision: 2, privateKey }).success).toBe(true);
    expect(setupBackupConfirmResponseSchema.safeParse({ data: { publicKey, confirmed: true, revision: 3 } }).success).toBe(true);
    expect(setupBackupConfirmResponseSchema.safeParse({ data: { publicKey, privateKey, confirmed: true, revision: 3 } }).success).toBe(false);
    expect(setupBackupConfirmRequestSchema.safeParse({ revision: 2, privateKey: publicKey }).success).toBe(false);
  });
  it('restores at step 0, skips setup on success, and leaves billing paused', () => {
    expect(setupRestoreRequestSchema.safeParse({ choice: 'restore', source: destination, snapshotPrefix: 'snapshot-1', privateKey }).success).toBe(true);
    expect(setupRestoreResponseSchema.safeParse({ data: { status: 'running', jobId: id, phase: 'verifying' } }).success).toBe(true);
    expect(setupRestoreResponseSchema.safeParse({ data: { status: 'restored', jobId: id, billingEnabled: false, next: 'login' } }).success).toBe(true);
    expect(setupRestoreResponseSchema.safeParse({ data: { status: 'restored', jobId: id, billingEnabled: true, next: 'login' } }).success).toBe(false);
    expect(setupRestoreResponseSchema.safeParse({ data: { status: 'restored', jobId: id, billingEnabled: false, next: 'step_1' } }).success).toBe(false);
  });
  it('keeps billing and member emails off after importing or starting fresh', () => {
    expect(setupFinishRequestSchema.safeParse({ choice: 'import', importId: id, revision: 1 }).success).toBe(true);
    expect(setupFinishRequestSchema.safeParse({ choice: 'import', revision: 1 }).success).toBe(false);
    expect(setupFinishRequestSchema.safeParse({ choice: 'import', importId: id, revision: 1, skipBackups: true }).success).toBe(true);
    expect(setupFinishRequestSchema.safeParse({ choice: 'import', importId: id, revision: 1, skipBackups: false }).success).toBe(false);
    expect(setupFinishRequestSchema.safeParse({ choice: 'fresh', importId: id, revision: 1 }).success).toBe(false);
    const result = { completed: true, billingEnabled: false, memberEmailsEnabled: false, revision: 2 };
    expect(setupFinishResponseSchema.safeParse({ data: result }).success).toBe(true);
    expect(setupFinishResponseSchema.safeParse({ data: { ...result, billingEnabled: true } }).success).toBe(false);
    expect(setupFinishResponseSchema.safeParse({ data: { ...result, memberEmailsEnabled: true } }).success).toBe(false);
  });
});
