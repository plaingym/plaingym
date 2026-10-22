// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import { canStaff, isRoutePermission, staffRoles } from '../permissions.js';
import type { waiverSignatures, waiverTemplates } from '../../../db/src/schema/index.js';
import {
  waiverContracts, waiverTemplateSchema, waiverCreateTemplateRequestSchema,
  waiverPublishTemplateRequestSchema, waiverRetireTemplateRequestSchema, waiverSignRequestSchema,
  waiverSignatureSchema, waiverSigningSnapshotSchema, waiverTemplateListQuerySchema, waiverSignatureListResponseSchema,
  type WaiverTemplate, type WaiverSignature,
} from './index.js';

const id = '019a08bf-1234-7000-8000-000000000001';
const now = '2026-10-21T12:00:00Z';
const template = { id, name: 'Training', kind: 'waiver', version: 2, body: 'Terms', retiredAt: null, createdAt: now };
const signing = { memberId: id, templateId: id, templateVersion: 2, signer: { kind: 'guardian', name: 'Parent', relationship: 'parent' }, signatureImageKey: 'gym/signature.png', signatureImageHash: 'a'.repeat(64), consent: true };

describe('waiver version and signature contracts', () => {
  it('keeps immutable versions separate from the retirement concurrency check', () => {
    expect(waiverTemplateSchema.parse(template)).toEqual(template);
    expect(waiverCreateTemplateRequestSchema.parse({ name: 'Training', kind: 'agreement', body: 'Terms' }).kind).toBe('agreement');
    expect(waiverPublishTemplateRequestSchema.safeParse({ name: 'Training', kind: 'waiver', body: 'new' }).success).toBe(false);
    expect(waiverPublishTemplateRequestSchema.parse({ name: 'Training', kind: 'waiver', body: 'new', expectedVersion: 2 }).expectedVersion).toBe(2);
    for (const expectedVersion of [0, -1, 1.5, '2', undefined]) {
      expect(waiverRetireTemplateRequestSchema.safeParse({ expectedVersion }).success).toBe(false);
    }
    expect(waiverRetireTemplateRequestSchema.parse({ expectedVersion: 2 })).toEqual({ expectedVersion: 2 });
    // No fictional revision column is exposed while the schema CCR is open.
    expect(waiverTemplateSchema.safeParse({ ...template, revision: 1 }).success).toBe(false);
    expect(waiverTemplateSchema.parse({ ...template, retiredAt: now }).retiredAt).toBe(now);
  });
  it('requires explicit consent, the exact template version, and a complete guardian identity', () => {
    expect(waiverSignRequestSchema.parse(signing)).toEqual(signing);
    expect(waiverSignRequestSchema.safeParse({ ...signing, consent: false }).success).toBe(false);
    expect(waiverSignRequestSchema.safeParse({ ...signing, signer: { kind: 'guardian', name: 'Parent' } }).success).toBe(false);
    expect(waiverSignRequestSchema.safeParse({ ...signing, templateVersion: 0 }).success).toBe(false);
    expect(waiverSignRequestSchema.safeParse({ ...signing, signedAt: now }).success).toBe(false);
    expect(waiverSignRequestSchema.parse({ ...signing, signer: { kind: 'self', name: 'أحمد' } }).signer.name).toBe('أحمد');
    expect(waiverSignRequestSchema.safeParse({ ...signing, signatureImageHash: 'A'.repeat(64) }).success).toBe(false);
  });
  it('specifies the complete legal record before its one-time serialization', () => {
    const snapshot = {
      template: { id, name: 'Training', kind: 'agreement', version: 2, body: 'Terms' },
      member: { id, firstName: 'Child', lastName: 'Example', dateOfBirth: '2015-10-21' },
      signer: signing.signer, signedAt: now,
      signatureImage: { key: signing.signatureImageKey, hash: signing.signatureImageHash },
    };
    expect(waiverSigningSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(waiverSigningSnapshotSchema.safeParse({ ...snapshot, signatureImage: undefined }).success).toBe(false);
    expect(waiverSigningSnapshotSchema.safeParse({ ...snapshot, signer: { kind: 'guardian', name: 'Parent' } }).success).toBe(false);
    expect(waiverSigningSnapshotSchema.safeParse({ ...snapshot, template: { ...snapshot.template, version: 0 } }).success).toBe(false);
  });
  it('preserves the exact snapshot text and omits signing IP from shared responses', () => {
    const snapshot = '{ "body": "Terms",\n "signer": "أحمد" }';
    const signature = { id, memberId: id, templateId: id, snapshot, snapshotHash: 'b'.repeat(64), signatureImageKey: signing.signatureImageKey, signatureImageHash: signing.signatureImageHash, signedAt: now };
    expect(waiverSignatureSchema.parse(signature).snapshot).toBe(snapshot);
    expect(waiverSignatureSchema.safeParse({ ...signature, snapshot: { body: 'Terms' } }).success).toBe(false);
    expect(waiverSignatureSchema.safeParse({ ...signature, ipAddress: '127.0.0.1' }).success).toBe(false);
    expect(waiverSignatureListResponseSchema.parse({ data: [signature], pagination: { limit: 50, offset: 0, total: 1 } }).data).toEqual([signature]);
  });
  it('extends the strict pagination query without accepting arbitrary filters', () => {
    expect(waiverTemplateListQuerySchema.parse({ limit: '10', kind: 'waiver' })).toEqual({ limit: 10, offset: 0, kind: 'waiver', includeRetired: 'false' });
    expect(waiverTemplateListQuerySchema.safeParse({ includeRetired: 'false', gymId: id }).success).toBe(false);
    expect(waiverTemplateListQuerySchema.safeParse({ includeRetired: true }).success).toBe(false);
  });
  it('declares staff permissions for every endpoint and limits template changes to managers', () => {
    const managers = new Set(['createTemplate', 'publishTemplate', 'retireTemplate']);
    for (const [name, contract] of Object.entries(waiverContracts)) {
      expect(isRoutePermission(contract.permission)).toBe(true);
      for (const role of staffRoles) {
        const allowed = managers.has(name) ? ['owner', 'admin'].includes(role) : name === 'sign' ? role !== 'coach' : true;
        expect(canStaff([role], contract.permission.capability), `${name}: ${role}`).toBe(allowed);
      }
      expect(canStaff([], contract.permission.capability)).toBe(false);
    }
  });
  it('matches the locked database projections after timestamp serialization', () => {
    type TemplateRow = typeof waiverTemplates.$inferSelect;
    type SignatureRow = typeof waiverSignatures.$inferSelect;
    expectTypeOf<Pick<WaiverTemplate, 'id' | 'name' | 'version' | 'body'>>().toEqualTypeOf<Pick<TemplateRow, 'id' | 'name' | 'version' | 'body'>>();
    expectTypeOf<Pick<WaiverSignature, 'id' | 'memberId' | 'templateId' | 'snapshot' | 'snapshotHash' | 'signatureImageKey' | 'signatureImageHash'>>().toEqualTypeOf<Pick<SignatureRow, 'id' | 'memberId' | 'templateId' | 'snapshot' | 'snapshotHash' | 'signatureImageKey' | 'signatureImageHash'>>();
    expectTypeOf<Exclude<keyof WaiverTemplate, keyof TemplateRow>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<keyof WaiverSignature, keyof SignatureRow>>().toEqualTypeOf<never>();
  });
});
