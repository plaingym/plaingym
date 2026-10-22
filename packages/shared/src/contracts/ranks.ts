// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import {
  idSchema, instantSchema, revisionSchema, paginationSchema, listResponseSchema,
} from './common.js';
import { contentPackSchema } from '../packs.js';
import type { RoutePermission } from '../permissions.js';

const nameSchema = z.string().trim().min(1);
const nonnegativeInt = z.int32().nonnegative();
const recordFields = { id: idSchema, gymId: idSchema, createdAt: instantSchema };
const read = { kind: 'staff', capability: 'members.read' } as const satisfies RoutePermission;
const manage = { kind: 'staff', capability: 'promotions.manage' } as const satisfies RoutePermission;
const configure = { kind: 'staff', capability: 'settings.manage' } as const satisfies RoutePermission;
const idParams = z.strictObject({ id: idSchema });

export const rankSubRankSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/), name: nameSchema,
});
/** Provider-owned configuration is stored in ranks.criteria, never in new columns. */
export const promotionCriterionSchema = z.strictObject({
  providerId: nameSchema, config: z.record(z.string(), z.json()),
});
export const rankSystemSchema = z.strictObject({
  ...recordFields, name: nameSchema, installedPackId: idSchema.nullable(), revision: revisionSchema,
});
export const programSchema = z.strictObject({
  ...recordFields, name: nameSchema, rankSystemId: idSchema.nullable(), active: z.boolean(), revision: revisionSchema,
});
export const rankSchema = z.strictObject({
  ...recordFields, rankSystemId: idSchema, name: nameSchema, position: nonnegativeInt,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  subRanks: z.array(rankSubRankSchema).refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    'Sub-rank IDs must be unique',
  ),
  criteria: z.array(promotionCriterionSchema), revision: revisionSchema,
});
export const promotionSchema = z.strictObject({
  ...recordFields, memberId: idSchema, programId: idSchema, rankId: idSchema, rankSystemId: idSchema,
  subRank: nonnegativeInt, promotedAt: instantSchema, promotedBy: idSchema.nullable(), notes: z.string().nullable(),
});
export const createProgramRequestSchema = programSchema.pick({ name: true, rankSystemId: true, active: true });
export const updateProgramRequestSchema = createProgramRequestSchema.partial().extend({ revision: revisionSchema })
  .refine((value) => Object.keys(value).length > 1, 'Supply at least one change');
export const createRankSystemRequestSchema = rankSystemSchema.pick({ name: true });
export const updateRankSystemRequestSchema = createRankSystemRequestSchema.extend({ revision: revisionSchema });
export const createRankRequestSchema = rankSchema.pick({
  rankSystemId: true, name: true, position: true, color: true, subRanks: true, criteria: true,
}).partial({ color: true });
/** A rank stays in its system; its editable fields use compare-and-set revisions. */
export const updateRankRequestSchema = createRankRequestSchema.omit({ rankSystemId: true }).partial()
  .extend({ revision: revisionSchema })
  .refine((value) => Object.keys(value).length > 1, 'Supply at least one change');
/** The service resolves both IDs and rejects a program/rank outside rankSystemId. */
export const createPromotionRequestSchema = z.strictObject({
  memberId: idSchema, programId: idSchema, rankId: idSchema, rankSystemId: idSchema,
  subRank: nonnegativeInt, promotedAt: instantSchema, notes: z.string().nullable().optional(),
});
export const bulkPromoteRequestSchema = createPromotionRequestSchema.omit({ memberId: true }).extend({
  memberIds: z.array(idSchema).min(1).max(100).refine(
    (ids) => new Set(ids).size === ids.length, 'A member may be promoted only once per request',
  ),
});
export const criterionProgressSchema = z.strictObject({
  providerId: nameSchema, labelKey: nameSchema,
  current: z.number().finite().nonnegative(), target: z.number().finite().nonnegative(), met: z.boolean(),
});
/** Resolved references expose the shared rank system without trusting client joins. */
export const promotionEligibilitySchema = z.strictObject({
  memberId: idSchema, rankSystemId: idSchema,
  program: z.strictObject({ id: idSchema, rankSystemId: idSchema }),
  rank: z.strictObject({ id: idSchema, rankSystemId: idSchema }),
  subRank: nonnegativeInt, eligible: z.boolean(), criteria: z.array(criterionProgressSchema),
}).refine((value) => value.program.rankSystemId === value.rankSystemId && value.rank.rankSystemId === value.rankSystemId,
  'The program and rank must share the recorded rank system')
  .refine((value) => value.eligible === value.criteria.every((criterion) => criterion.met),
    'Eligibility must agree with the criterion results');
export const installedPackSchema = z.strictObject({
  ...recordFields, packId: z.string().regex(/^[a-z][a-z0-9-]*$/), version: z.int32().positive(),
});
/** Shipped definitions contain no gym data and can be listed before setup. */
export const contentPackCatalogEntrySchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/), name: nameSchema,
  version: z.int32().positive(), summary: nameSchema,
});
/** Reuse the versioned pack format, including its duplicate/reference checks. */
export const applyContentPackRequestSchema = z.strictObject({ pack: contentPackSchema });
export const applyContentPackResponseSchema = z.strictObject({ data: z.strictObject({
  installedPack: installedPackSchema, rankSystems: z.array(rankSystemSchema), programs: z.array(programSchema),
}) });
export const programListQuerySchema = paginationSchema.extend({
  active: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  rankSystemId: idSchema.optional(),
});
export const rankListQuerySchema = paginationSchema.extend({ rankSystemId: idSchema });
export const promotionListQuerySchema = paginationSchema.extend({ memberId: idSchema, programId: idSchema.optional() });
export const eligibilityListQuerySchema = paginationSchema.extend({
  programId: idSchema, rankId: idSchema, readyOnly: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
});

// Stale revisions and cross-system references use the shared conflict error (409).
export const ranksContracts = {
  catalog: { method: 'get', path: '/api/content-packs/catalog', permission: { kind: 'public' },
    response: z.strictObject({ data: z.array(contentPackCatalogEntrySchema) }) },
  listPrograms: { method: 'get', path: '/api/programs', permission: read,
    query: programListQuerySchema, response: listResponseSchema(programSchema) },
  createProgram: { method: 'post', path: '/api/programs', permission: configure,
    body: createProgramRequestSchema, response: z.strictObject({ data: programSchema }) },
  updateProgram: { method: 'patch', path: '/api/programs/{id}', permission: configure,
    params: idParams, body: updateProgramRequestSchema, response: z.strictObject({ data: programSchema }) },
  listRankSystems: { method: 'get', path: '/api/rank-systems', permission: read,
    query: paginationSchema, response: listResponseSchema(rankSystemSchema) },
  createRankSystem: { method: 'post', path: '/api/rank-systems', permission: configure,
    body: createRankSystemRequestSchema, response: z.strictObject({ data: rankSystemSchema }) },
  updateRankSystem: { method: 'patch', path: '/api/rank-systems/{id}', permission: configure,
    params: idParams, body: updateRankSystemRequestSchema, response: z.strictObject({ data: rankSystemSchema }) },
  listRanks: { method: 'get', path: '/api/ranks', permission: read,
    query: rankListQuerySchema, response: listResponseSchema(rankSchema) },
  createRank: { method: 'post', path: '/api/ranks', permission: configure,
    body: createRankRequestSchema, response: z.strictObject({ data: rankSchema }) },
  updateRank: { method: 'patch', path: '/api/ranks/{id}', permission: configure,
    params: idParams, body: updateRankRequestSchema, response: z.strictObject({ data: rankSchema }) },
  listPromotions: { method: 'get', path: '/api/promotions', permission: read,
    query: promotionListQuerySchema, response: listResponseSchema(promotionSchema) },
  promote: { method: 'post', path: '/api/promotions', permission: manage,
    body: createPromotionRequestSchema, response: z.strictObject({ data: promotionSchema }) },
  bulkPromote: { method: 'post', path: '/api/promotions/bulk', permission: manage,
    body: bulkPromoteRequestSchema, response: z.strictObject({ data: z.array(promotionSchema).min(1).max(100) }) },
  eligibility: { method: 'get', path: '/api/promotions/eligibility', permission: manage,
    query: eligibilityListQuerySchema, response: listResponseSchema(promotionEligibilitySchema) },
  listPacks: { method: 'get', path: '/api/content-packs', permission: configure,
    query: paginationSchema, response: listResponseSchema(installedPackSchema) },
  applyPack: { method: 'post', path: '/api/content-packs/apply', permission: configure,
    body: applyContentPackRequestSchema, response: applyContentPackResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type Program = z.infer<typeof programSchema>;
export type RankSystem = z.infer<typeof rankSystemSchema>;
export type Rank = z.infer<typeof rankSchema>;
export type Promotion = z.infer<typeof promotionSchema>;
export type PromotionCriterion = z.infer<typeof promotionCriterionSchema>;
export type CriterionProgress = z.infer<typeof criterionProgressSchema>;
export type PromotionEligibility = z.infer<typeof promotionEligibilitySchema>;
export type InstalledPack = z.infer<typeof installedPackSchema>;
export type ContentPackCatalogEntry = z.infer<typeof contentPackCatalogEntrySchema>;
export type CreateProgramRequest = z.infer<typeof createProgramRequestSchema>;
export type UpdateProgramRequest = z.infer<typeof updateProgramRequestSchema>;
export type CreateRankSystemRequest = z.infer<typeof createRankSystemRequestSchema>;
export type UpdateRankSystemRequest = z.infer<typeof updateRankSystemRequestSchema>;
export type CreateRankRequest = z.infer<typeof createRankRequestSchema>;
export type UpdateRankRequest = z.infer<typeof updateRankRequestSchema>;
export type CreatePromotionRequest = z.infer<typeof createPromotionRequestSchema>;
export type BulkPromoteRequest = z.infer<typeof bulkPromoteRequestSchema>;
export type ApplyContentPackRequest = z.infer<typeof applyContentPackRequestSchema>;
