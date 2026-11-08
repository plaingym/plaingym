// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { dateSchema, idSchema, instantSchema, listResponseSchema, paginationSchema } from './common.js';

export const waiverKindSchema = z.enum(['waiver', 'agreement']);
export const waiverTemplateVersionSchema = z.int32().positive();
export const waiverDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const waiverDocumentSchema = z.strictObject({
  key: z.string().min(1), hash: waiverDigestSchema, pages: z.int().min(1).max(20), bytes: z.int().min(1).max(10 * 1024 * 1024),
});
export const waiverTemplateSchema = z.strictObject({
  id: idSchema, name: z.string().min(1), kind: waiverKindSchema,
  version: waiverTemplateVersionSchema, body: z.string(), document: waiverDocumentSchema.optional(),
  retiredAt: instantSchema.nullable(), createdAt: instantSchema,
});
// Families are identified by name. Select the latest version before filtering
// retired families, so retiring one never brings an older version back.
export const waiverTemplateListQuerySchema = paginationSchema.extend({
  kind: waiverKindSchema.optional(),
  includeRetired: z.enum(['true', 'false']).default('false'),
});
export const waiverTemplateListResponseSchema = listResponseSchema(waiverTemplateSchema);
export const waiverTemplateResponseSchema = z.strictObject({ data: waiverTemplateSchema });
const templateInput = waiverTemplateSchema.pick({ name: true, kind: true, document: true }).extend({ body: z.string().default('') });
const oneContent = (input: { body: string; document?: unknown }) => input.document ? input.body === '' : input.body.trim().length > 0;
export const waiverCreateTemplateRequestSchema = templateInput.refine(oneContent, 'Provide either waiver text or a PDF document');
// Templates are published as immutable versions. Services compare expectedVersion
// with the current family version, returning the shared conflict error on a stale save.
// Under the same per-family lock as publication, retirement checks the latest
// family version and marks that immutable version retired. Repeating retirement is idempotent; publishing
// a new version makes an older expectedVersion conflict. No row revision is needed.
export const waiverPublishTemplateRequestSchema = templateInput.extend({
  expectedVersion: waiverTemplateVersionSchema,
}).refine(oneContent, 'Provide either waiver text or a PDF document');
export const waiverRetireTemplateRequestSchema = z.strictObject({ expectedVersion: waiverTemplateVersionSchema });
export const waiverTemplateParamsSchema = z.strictObject({ templateId: idSchema });
export const waiverSignatureParamsSchema = z.strictObject({ signatureId: idSchema });

export const waiverSignerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('self'), name: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal('guardian'), name: z.string().trim().min(1), relationship: z.string().trim().min(1) }),
]);
// Services validate this complete record, serialize it once, and hash its UTF-8
// bytes. Reads and PDFs keep using that original text after a template changes.
export const waiverSigningSnapshotSchema = z.strictObject({
  template: waiverTemplateSchema.pick({ id: true, name: true, kind: true, version: true, body: true, document: true }),
  member: z.strictObject({ id: idSchema, firstName: z.string().min(1), lastName: z.string().min(1), dateOfBirth: dateSchema.nullable() }),
  signer: waiverSignerSchema, signedAt: instantSchema,
  commitmentEndsOn: dateSchema.nullable().optional(),
  signatureImage: z.strictObject({ key: z.string().min(1), hash: waiverDigestSchema }),
});
// The service checks age from the scoped member record and requires a guardian
// for minors. The server supplies signing time, snapshot bytes, digest, and IP;
// it verifies the uploaded image belongs to this gym and matches its digest.
export const waiverSignRequestSchema = z.strictObject({
  memberId: idSchema, templateId: idSchema, templateVersion: waiverTemplateVersionSchema,
  signer: waiverSignerSchema, signatureImageKey: z.string().min(1),
  signatureImageHash: waiverDigestSchema, consent: z.literal(true),
  commitmentEndsOn: dateSchema.nullable().optional(),
});
export const waiverSignatureSchema = z.strictObject({
  id: idSchema, memberId: idSchema, templateId: idSchema,
  // Exact serialized text, never parsed and reserialized for hashing or PDF rendering.
  snapshot: z.string().min(1), snapshotHash: waiverDigestSchema,
  signatureImageKey: z.string().min(1), signatureImageHash: waiverDigestSchema, signedAt: instantSchema,
});
export const waiverSignatureListQuerySchema = paginationSchema.extend({
  memberId: idSchema.optional(), templateId: idSchema.optional(),
});
export const waiverSignatureListResponseSchema = listResponseSchema(waiverSignatureSchema);
export const waiverSignatureResponseSchema = z.strictObject({ data: waiverSignatureSchema });
export const waiverPdfResponseSchema = z.strictObject({
  data: z.strictObject({ url: z.url({ protocol: /^https?$/ }), expiresAt: instantSchema }),
});

export const waiverUploadRequestSchema = z.strictObject({
  memberId: idSchema,
  pngBase64: z.string().min(1).max(350_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export const waiverUploadResponseSchema = z.strictObject({ data: z.strictObject({
  signatureImageKey: z.string().min(1), signatureImageHash: waiverDigestSchema,
}) });
export const waiverDocumentResponseSchema = z.strictObject({ data: waiverDocumentSchema });

export const waiverDocumentReadContracts = {
  portal: { method: 'get', path: '/api/portal/waiver-templates/{templateId}/document', permission: { kind: 'member', capability: 'waivers.self' },
    params: waiverTemplateParamsSchema, response: waiverPdfResponseSchema.extend({ householdId: idSchema }) },
  household: { method: 'get', path: '/api/portal/household/waiver-templates/{templateId}/document', permission: { kind: 'member', capability: 'waivers.household' },
    params: waiverTemplateParamsSchema, response: waiverPdfResponseSchema.extend({ householdId: idSchema }) },
  public: { method: 'get', path: '/api/public/waivers/{templateId}/document', permission: { kind: 'public' },
    params: waiverTemplateParamsSchema, query: z.strictObject({ view: z.literal('1').optional() }), response: waiverPdfResponseSchema },
  link: { method: 'get', path: '/api/links/sign-waiver/templates/{templateId}/document', permission: { kind: 'signed_link', purpose: 'sign_waiver' },
    params: waiverTemplateParamsSchema, response: waiverPdfResponseSchema },
} as const satisfies Record<string, EndpointContract>;


export const waiverContracts = {
  uploadDocument: { method: 'post', path: '/api/waivers/template-documents', permission: { kind: 'staff', capability: 'settings.manage' }, response: waiverDocumentResponseSchema },
  document: { method: 'get', path: '/api/waivers/templates/{templateId}/document', permission: { kind: 'staff', capability: 'members.read' }, params: waiverTemplateParamsSchema, response: waiverPdfResponseSchema },
  uploadSignature: { method: 'post', path: '/api/waivers/signature-images', permission: { kind: 'staff', capability: 'members.manage' }, body: waiverUploadRequestSchema, response: waiverUploadResponseSchema },
  listTemplates: { method: 'get', path: '/api/waivers/templates', permission: { kind: 'staff', capability: 'members.read' }, query: waiverTemplateListQuerySchema, response: waiverTemplateListResponseSchema },
  createTemplate: { method: 'post', path: '/api/waivers/templates', permission: { kind: 'staff', capability: 'settings.manage' }, body: waiverCreateTemplateRequestSchema, response: waiverTemplateResponseSchema },
  publishTemplate: { method: 'post', path: '/api/waivers/templates/{templateId}/versions', permission: { kind: 'staff', capability: 'settings.manage' }, params: waiverTemplateParamsSchema, body: waiverPublishTemplateRequestSchema, response: waiverTemplateResponseSchema },
  retireTemplate: { method: 'post', path: '/api/waivers/templates/{templateId}/retire', permission: { kind: 'staff', capability: 'settings.manage' }, params: waiverTemplateParamsSchema, body: waiverRetireTemplateRequestSchema, response: waiverTemplateResponseSchema },
  listSignatures: { method: 'get', path: '/api/waivers/signatures', permission: { kind: 'staff', capability: 'members.read' }, query: waiverSignatureListQuerySchema, response: waiverSignatureListResponseSchema },
  sign: { method: 'post', path: '/api/waivers/signatures', permission: { kind: 'staff', capability: 'members.manage' }, body: waiverSignRequestSchema, response: waiverSignatureResponseSchema },
  pdf: { method: 'get', path: '/api/waivers/signatures/{signatureId}/pdf', permission: { kind: 'staff', capability: 'members.read' }, params: waiverSignatureParamsSchema, response: waiverPdfResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type WaiverKind = z.infer<typeof waiverKindSchema>;
export type WaiverDocument = z.infer<typeof waiverDocumentSchema>;
export type WaiverTemplate = z.infer<typeof waiverTemplateSchema>;
export type WaiverTemplateListQuery = z.infer<typeof waiverTemplateListQuerySchema>;
export type WaiverCreateTemplateRequest = z.infer<typeof waiverCreateTemplateRequestSchema>;
export type WaiverPublishTemplateRequest = z.infer<typeof waiverPublishTemplateRequestSchema>;
export type WaiverRetireTemplateRequest = z.infer<typeof waiverRetireTemplateRequestSchema>;
export type WaiverSigner = z.infer<typeof waiverSignerSchema>;
export type WaiverSigningSnapshot = z.infer<typeof waiverSigningSnapshotSchema>;
export type WaiverSignRequest = z.infer<typeof waiverSignRequestSchema>;
export type WaiverSignature = z.infer<typeof waiverSignatureSchema>;
export type WaiverSignatureListQuery = z.infer<typeof waiverSignatureListQuerySchema>;
export type WaiverPdfResponse = z.infer<typeof waiverPdfResponseSchema>;
