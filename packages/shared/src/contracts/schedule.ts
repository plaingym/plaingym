// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { classKindSchema, classSessionStatusSchema } from './states.js';
import { idSchema, instantSchema, listResponseSchema, paginationSchema, revisionSchema } from './common.js';
import type { RoutePermission } from '../permissions.js';

const readSchedule = { kind: 'staff', capability: 'bookings.manage' } as const satisfies RoutePermission;
const manageSchedule = { kind: 'staff', capability: 'schedule.manage' } as const satisfies RoutePermission;
const manageNotes = { kind: 'staff', capability: 'class_notes.manage' } as const satisfies RoutePermission;
const nameSchema = z.string().trim().min(1);
const relatedIdsSchema = z.array(idSchema).refine((ids) => new Set(ids).size === ids.length, 'IDs must be unique');
export const scheduleIdParamsSchema = z.strictObject({ id: idSchema });
export const scheduleRevisionRequestSchema = z.strictObject({ revision: revisionSchema });
export { classKindSchema, classSessionStatusSchema } from './states.js';
/** Sunday is 0. Local wall time is interpreted in the gym timezone during materialization. */
export const classTemplateFieldsSchema = z.strictObject({
  name: nameSchema,
  weekday: z.int32().min(0).max(6),
  localStartTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  durationMinutes: z.int32().positive(),
  coachId: idSchema.nullable(),
  capacity: z.int32().positive().nullable(),
  notes: z.string().nullable(),
  kind: classKindSchema,
  programIds: relatedIdsSchema.refine((ids) => ids.length > 0, 'A class needs a program'),
  tagIds: relatedIdsSchema,
});
export const createClassTagRequestSchema = z.strictObject({ name: nameSchema });
export const updateClassTagRequestSchema = createClassTagRequestSchema.extend({ revision: revisionSchema });
export const classTagSchema = z.strictObject({
  id: idSchema, name: nameSchema, createdAt: instantSchema, revision: revisionSchema,
});
export const classTagResponseSchema = z.strictObject({ data: classTagSchema });
export const classTagListResponseSchema = listResponseSchema(classTagSchema);
export const classTagListQuerySchema = paginationSchema.extend({ search: z.string().trim().min(1).optional() });
/** Kind defaults to a class on create; full-replacement updates must send it. */
export const createClassTemplateRequestSchema = classTemplateFieldsSchema.extend({ kind: classKindSchema.default('class') });
/** Full replacement keeps weekday, local time, duration and mappings in one revision-guarded save. */
export const updateClassTemplateRequestSchema = classTemplateFieldsSchema.extend({ revision: revisionSchema });
export const classTemplateSchema = classTemplateFieldsSchema.extend({
  id: idSchema, createdAt: instantSchema, revision: revisionSchema,
});
export const classTemplateResponseSchema = z.strictObject({ data: classTemplateSchema });
export const classTemplateListResponseSchema = listResponseSchema(classTemplateSchema);
export const classTemplateListQuerySchema = paginationSchema.extend({
  coachId: idSchema.optional(), programId: idSchema.optional(), tagId: idSchema.optional(),
});
const sessionFieldsSchema = z.strictObject({
  name: nameSchema,
  startsAt: instantSchema,
  endsAt: instantSchema,
  coachId: idSchema.nullable(),
  capacity: z.int32().positive().nullable(),
  notes: z.string().nullable(),
  kind: classKindSchema,
  programIds: relatedIdsSchema.refine((ids) => ids.length > 0, 'A class needs a program'),
  tagIds: relatedIdsSchema,
});
const orderedTimes = (value: { startsAt: string; endsAt: string }) => Date.parse(value.endsAt) > Date.parse(value.startsAt);
export const createClassSessionRequestSchema = sessionFieldsSchema.extend({ kind: classKindSchema.default('class') }).refine(orderedTimes, {
  path: ['endsAt'], message: 'Session must end after it starts',
});
export const updateClassSessionRequestSchema = sessionFieldsSchema.extend({ revision: revisionSchema }).refine(orderedTimes, {
  path: ['endsAt'], message: 'Session must end after it starts',
});
export const classSessionSchema = sessionFieldsSchema.extend({
  id: idSchema, templateId: idSchema.nullable(), status: classSessionStatusSchema,
  createdAt: instantSchema, revision: revisionSchema,
}).refine(orderedTimes, { path: ['endsAt'], message: 'Session must end after it starts' });
export const classSessionResponseSchema = z.strictObject({ data: classSessionSchema });
export const classSessionListResponseSchema = listResponseSchema(classSessionSchema);
/** Filter interval is [from, until); compare instants, including explicit DST offsets. */
export const classSessionListQuerySchema = paginationSchema.extend({
  from: instantSchema, until: instantSchema,
  coachId: idSchema.optional(), programId: idSchema.optional(), tagId: idSchema.optional(),
  status: classSessionStatusSchema.optional(),
}).refine((value) => Date.parse(value.until) > Date.parse(value.from), {
  path: ['until'], message: 'Range must end after it starts',
});
export const swapSessionCoachRequestSchema = z.strictObject({ coachId: idSchema.nullable(), revision: revisionSchema });
export const updateSessionNotesRequestSchema = z.strictObject({ notes: z.string().nullable(), revision: revisionSchema });
/** Capacity changes use the same session lock as booking, cancellation and waitlist promotion. */
export const updateSessionCapacityRequestSchema = z.strictObject({ capacity: z.int32().positive().nullable(), revision: revisionSchema });
const removedResponseSchema = z.strictObject({ data: z.strictObject({ id: idSchema }) });

/** Contract metadata only. Stale revisions use the shared conflict error (409). */
export const scheduleContracts = {
  listTags: { method: 'get', path: '/api/schedule/tags', permission: readSchedule, query: classTagListQuerySchema, response: classTagListResponseSchema },
  createTag: { method: 'post', path: '/api/schedule/tags', permission: manageSchedule, body: createClassTagRequestSchema, response: classTagResponseSchema },
  updateTag: { method: 'put', path: '/api/schedule/tags/{id}', permission: manageSchedule, params: scheduleIdParamsSchema, body: updateClassTagRequestSchema, response: classTagResponseSchema },
  deleteTag: { method: 'delete', path: '/api/schedule/tags/{id}', permission: manageSchedule, params: scheduleIdParamsSchema, body: scheduleRevisionRequestSchema, response: removedResponseSchema },
  listTemplates: { method: 'get', path: '/api/schedule/templates', permission: readSchedule, query: classTemplateListQuerySchema, response: classTemplateListResponseSchema },
  getTemplate: { method: 'get', path: '/api/schedule/templates/{id}', permission: readSchedule, params: scheduleIdParamsSchema, response: classTemplateResponseSchema },
  createTemplate: { method: 'post', path: '/api/schedule/templates', permission: manageSchedule, body: createClassTemplateRequestSchema, response: classTemplateResponseSchema },
  updateTemplate: { method: 'put', path: '/api/schedule/templates/{id}', permission: manageSchedule, params: scheduleIdParamsSchema, body: updateClassTemplateRequestSchema, response: classTemplateResponseSchema },
  deleteTemplate: { method: 'delete', path: '/api/schedule/templates/{id}', permission: manageSchedule, params: scheduleIdParamsSchema, body: scheduleRevisionRequestSchema, response: removedResponseSchema },
  listSessions: { method: 'get', path: '/api/schedule/sessions', permission: readSchedule, query: classSessionListQuerySchema, response: classSessionListResponseSchema },
  getSession: { method: 'get', path: '/api/schedule/sessions/{id}', permission: readSchedule, params: scheduleIdParamsSchema, response: classSessionResponseSchema },
  createSession: { method: 'post', path: '/api/schedule/sessions', permission: manageSchedule, body: createClassSessionRequestSchema, response: classSessionResponseSchema },
  updateSession: { method: 'put', path: '/api/schedule/sessions/{id}', permission: manageSchedule, params: scheduleIdParamsSchema, body: updateClassSessionRequestSchema, response: classSessionResponseSchema },
  cancelSession: { method: 'post', path: '/api/schedule/sessions/{id}/cancel', permission: manageSchedule, params: scheduleIdParamsSchema, body: scheduleRevisionRequestSchema, response: classSessionResponseSchema },
  swapCoach: { method: 'post', path: '/api/schedule/sessions/{id}/coach', permission: manageSchedule, params: scheduleIdParamsSchema, body: swapSessionCoachRequestSchema, response: classSessionResponseSchema },
  updateNotes: { method: 'patch', path: '/api/schedule/sessions/{id}/notes', permission: manageNotes, params: scheduleIdParamsSchema, body: updateSessionNotesRequestSchema, response: classSessionResponseSchema },
  updateCapacity: { method: 'patch', path: '/api/schedule/sessions/{id}/capacity', permission: manageSchedule, params: scheduleIdParamsSchema, body: updateSessionCapacityRequestSchema, response: classSessionResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type ClassTag = z.infer<typeof classTagSchema>;
export type CreateClassTagRequest = z.infer<typeof createClassTagRequestSchema>;
export type UpdateClassTagRequest = z.infer<typeof updateClassTagRequestSchema>;
export type ClassTagListQuery = z.infer<typeof classTagListQuerySchema>;
export type ClassTemplate = z.infer<typeof classTemplateSchema>;
export type CreateClassTemplateRequest = z.infer<typeof createClassTemplateRequestSchema>;
export type UpdateClassTemplateRequest = z.infer<typeof updateClassTemplateRequestSchema>;
export type ClassTemplateListQuery = z.infer<typeof classTemplateListQuerySchema>;
export type ClassKind = z.infer<typeof classKindSchema>;
export type ClassSession = z.infer<typeof classSessionSchema>;
export type CreateClassSessionRequest = z.infer<typeof createClassSessionRequestSchema>;
export type UpdateClassSessionRequest = z.infer<typeof updateClassSessionRequestSchema>;
export type ClassSessionListQuery = z.infer<typeof classSessionListQuerySchema>;
export type SwapSessionCoachRequest = z.infer<typeof swapSessionCoachRequestSchema>;
export type UpdateSessionNotesRequest = z.infer<typeof updateSessionNotesRequestSchema>;
export type UpdateSessionCapacityRequest = z.infer<typeof updateSessionCapacityRequestSchema>;
export type ScheduleRevisionRequest = z.infer<typeof scheduleRevisionRequestSchema>;

export type ClassTagResponse = z.infer<typeof classTagResponseSchema>;
export type ClassTagListResponse = z.infer<typeof classTagListResponseSchema>;
export type ClassTemplateResponse = z.infer<typeof classTemplateResponseSchema>;
export type ClassTemplateListResponse = z.infer<typeof classTemplateListResponseSchema>;
export type ClassSessionResponse = z.infer<typeof classSessionResponseSchema>;
export type ClassSessionListResponse = z.infer<typeof classSessionListResponseSchema>;
