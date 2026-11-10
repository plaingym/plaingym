// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idSchema, instantSchema, listResponseSchema, paginationSchema } from './common.js';
import type { EndpointContract } from './definition.js';

export const announcementAudienceSchema = z.strictObject({
  statuses: z.array(z.enum(['active', 'trial', 'frozen'])).min(1).max(3).default(['active', 'trial', 'frozen']),
  programIds: z.array(idSchema).max(100).default([]),
});
export const announcementDraftSchema = z.strictObject({
  subject: z.string().trim().min(1).max(150).regex(/^[^\r\n]+$/).refine(value => !value.includes(String.fromCharCode(0)), 'Invalid subject'),
  body: z.string().trim().min(1).max(10000),
  audience: announcementAudienceSchema.default({ statuses: ['active', 'trial', 'frozen'], programIds: [] }),
});
/** Gym-scoped idempotency generation, separate from the server-generated announcement ID. Keep across retries. */
export const sendAnnouncementSchema = announcementDraftSchema.extend({ sendGeneration: idSchema, confirm: z.literal(true) });
export const announcementSchema = z.strictObject({
  id: idSchema, createdBy: idSchema, subject: z.string(), body: z.string(), audience: announcementAudienceSchema,
  recipientCount: z.int().nonnegative(), status: z.enum(['sending', 'sent']),
  createdAt: instantSchema, completedAt: instantSchema.nullable(),
  sent: z.int().nonnegative(), failed: z.int().nonnegative(), skipped: z.int().nonnegative(),
});
const permission = { kind: 'staff', capability: 'announcements.send' } as const;
const response = z.strictObject({ data: announcementSchema });
export const announcementsContracts = {
  // Preview and a new send refuse with reason disabled, no_smtp or no_origin (canonical HTTPS origin required).
  preview: { method: 'post', path: '/api/announcements/preview', permission, body: announcementDraftSchema,
    response: z.strictObject({ data: z.strictObject({ recipientCount: z.int().nonnegative() }) }) },
  test: { method: 'post', path: '/api/announcements/test', permission, body: announcementDraftSchema,
    response: z.strictObject({ data: z.strictObject({ sent: z.literal(true) }) }) },
  send: { method: 'post', path: '/api/announcements/send', permission, body: sendAnnouncementSchema, response },
  list: { method: 'get', path: '/api/announcements', permission, query: paginationSchema, response: listResponseSchema(announcementSchema) },
  get: { method: 'get', path: '/api/announcements/{announcementId}', permission,
    params: z.strictObject({ announcementId: idSchema }), response },
} as const satisfies Record<string, EndpointContract>;
export type AnnouncementDraft = z.infer<typeof announcementDraftSchema>;
export type AnnouncementAudience = z.infer<typeof announcementAudienceSchema>;
export type SendAnnouncement = z.infer<typeof sendAnnouncementSchema>;
