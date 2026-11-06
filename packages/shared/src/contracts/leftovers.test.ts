// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  demoContracts, gymBrandingSchema, installContracts, installHealthSchema, installSourceSchema,
  joinAdmissionSchema, joinAdmissionResponseSchema, outboxMessageResponse, outboxResponse,
  promotionCriterionSchema, publicAdmissionSchema, publicAdmissionResponseSchema,
  publicSignatureUploadSchema, setupGymDetailsSchema, uploadCsvRequestSchema,
} from './index.js';

const id = '019a08bf-1234-7000-8000-000000000001';
const member = { firstName: 'Pat', lastName: 'Example', dateOfBirth: '1990-01-01' };
const contact = { name: 'Pat', email: 'pat@example.test' };
const signature = { templateId: id, templateVersion: 1, pngBase64: 'aGVsbG8=' };
const image = { templateId: id, templateVersion: 1, signatureImageKey: 'gym/signature.png', signatureImageHash: 'a'.repeat(64) };

describe('shared install and admission contracts', () => {
  it('keeps the install liveness and source shapes', () => {
    expect(installHealthSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
    expect(installHealthSchema.safeParse({ status: 'unhealthy' }).success).toBe(false);
    expect(installSourceSchema.safeParse({ data: { url: 'https://example.test/source' } }).success).toBe(true);
    expect(installSourceSchema.safeParse({ data: { url: 'not a URL' } }).success).toBe(false);
    expect(installContracts.sourceRedirect.responses[302].headers.Location.schema.format).toBe('uri');
    expect(installContracts.openApi.responses[200].content['application/json'].schema.meta()).toEqual({ type: 'object', description: 'OpenAPI 3.0 document' });
  });

  it('accepts the same null brand color in setup and settings', () => {
    const branding = { logoKey: null, primaryColor: null };
    const details = { name: 'Gym', timezone: 'UTC', currency: 'USD', address: {}, branding, revision: 1 };
    expect(setupGymDetailsSchema.parse(details).branding).toEqual(gymBrandingSchema.parse(branding));
    expect(gymBrandingSchema.safeParse({ primaryColor: '#12345g' }).success).toBe(false);
  });

  it('retains JSON validation under the shared OpenAPI annotation', () => {
    const config = promotionCriterionSchema.shape.config;
    expect(config.parse({ nested: [null, { count: 3, enabled: true }] })).toEqual({ nested: [null, { count: 3, enabled: true }] });
    expect(config.safeParse({ invalid: () => 1 }).success).toBe(false);
    expect(config.meta()).toEqual({ type: 'object', additionalProperties: {} });
  });

  it('retains file and size validation under the binary annotation', () => {
    expect(uploadCsvRequestSchema.safeParse({ file: new File(['a,b'], 'roster.csv') }).success).toBe(true);
    expect(uploadCsvRequestSchema.safeParse({ file: 'roster.csv' }).success).toBe(false);
    expect(uploadCsvRequestSchema.safeParse({ file: new File([], 'empty.csv') }).success).toBe(false);
    expect(uploadCsvRequestSchema.safeParse({ file: new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.csv') }).success).toBe(false);
    expect(uploadCsvRequestSchema.shape.file.meta()).toEqual({ type: 'string', format: 'binary' });
  });

  it('bounds encoded signatures without replacing decoded PNG validation', () => {
    expect(publicSignatureUploadSchema.parse(signature)).toEqual(signature);
    for (const pngBase64 of ['', 'invalid!', 'a'.repeat(350_001)])
      expect(publicSignatureUploadSchema.safeParse({ ...signature, pngBase64 }).success).toBe(false);
    expect(publicSignatureUploadSchema.safeParse({ ...signature, templateVersion: 0 }).success).toBe(false);
  });

  it('keeps drop-in admission strict and bounded to eight signatures', () => {
    const input = { contact, member, honeypot: '', signatures: [signature] };
    expect(publicAdmissionSchema.parse(input)).toEqual(input);
    for (const signatures of [[], Array.from({ length: 9 }, () => signature)])
      expect(publicAdmissionSchema.safeParse({ ...input, signatures }).success).toBe(false);
    expect(publicAdmissionSchema.safeParse({ ...input, householdId: id }).success).toBe(false);
    expect(publicAdmissionResponseSchema.parse({ data: [image] })).toEqual({ data: [image] });
  });

  it('keeps join admission bounded to six people and eight signatures each', () => {
    const person = { member, signatures: [signature] };
    const input = { contact, planId: id, honeypot: '', members: [person] };
    expect(joinAdmissionSchema.parse(input)).toEqual(input);
    for (const members of [[], Array.from({ length: 7 }, () => person), [{ member, signatures: [] }],
      [{ member, signatures: Array.from({ length: 9 }, () => signature) }]])
      expect(joinAdmissionSchema.safeParse({ ...input, members }).success).toBe(false);
    expect(joinAdmissionSchema.safeParse({ ...input, householdId: id }).success).toBe(false);
    expect(joinAdmissionResponseSchema.parse({ data: [[image]] })).toEqual({ data: [[image]] });
  });

  it('omits HTML from JSON responses while keeping the HTML preview', () => {
    const message = { id, subject: 'Hello', recipient: 'pat@example.test', text: 'Hello', sentAt: '2026-11-05T00:00:00Z' };
    expect(outboxResponse.parse({ data: [message], next: null }).data[0]).not.toHaveProperty('html');
    expect(outboxResponse.safeParse({ data: [{ ...message, html: '<p>Hello</p>' }], next: null }).success).toBe(false);
    expect(outboxMessageResponse.parse({ data: message }).data).not.toHaveProperty('html');
    expect(outboxMessageResponse.safeParse({ data: { ...message, html: '<p>Hello</p>' } }).success).toBe(false);
    expect(demoContracts.preview.params.safeParse({ id: 'invalid' }).success).toBe(false);
    expect(demoContracts.preview.response.parse('<p>Hello</p>')).toBe('<p>Hello</p>');
    expect(demoContracts.preview.permission).toEqual(demoContracts.message.permission);
  });
});
