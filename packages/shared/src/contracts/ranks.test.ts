// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { programs, ranks, rankSystems, memberRanks, installedPacks } from '../../../db/src/schema/index.js';
import {
  ranksContracts, programSchema, rankSchema, rankSystemSchema, promotionSchema,
  createRankRequestSchema, updateProgramRequestSchema, updateRankRequestSchema, updateRankSystemRequestSchema,
  bulkPromoteRequestSchema, promotionEligibilitySchema, applyContentPackRequestSchema,
  programListQuerySchema, type Program, type Rank, type RankSystem, type Promotion, type InstalledPack,
} from './index.js';
import { canStaff, staffRoles } from '../permissions.js';

const id = '019a08bf-1234-7000-8000-000000000001';
const otherId = '019a08bf-1234-7000-8000-000000000002';
const now = '2026-10-21T20:00:00Z';
const base = { id, gymId: id, createdAt: now, revision: 1 };
const program = { ...base, name: 'Adults', rankSystemId: id, active: true };
const rank = { ...base, rankSystemId: id, name: 'Level one', position: 0, color: null, subRanks: [], criteria: [] };
const appendOnlyPromotion = { id, gymId: id, createdAt: now, memberId: id, programId: id, rankId: id, rankSystemId: id,
  subRank: 0, promotedAt: now, promotedBy: null, notes: null };
const promotion = { ...appendOnlyPromotion, revision: 1 };

// Wire instants are strings; every other stored field is assignable to the locked row.
type WireRow<T extends { createdAt: Date }> = Omit<T, 'createdAt'> & { createdAt: string };

describe('rank and promotion contracts', () => {
  it('supports nullable six-digit rank colors in reads, creation and revision-guarded updates', () => {
    for (const color of [null, '#000000', '#aBcDeF']) {
      expect(rankSchema.parse({ ...rank, color }).color).toBe(color);
      expect(createRankRequestSchema.parse({ rankSystemId: id, name: 'Rank', position: 0, subRanks: [], criteria: [], color }).color).toBe(color);
      expect(updateRankRequestSchema.parse({ color, revision: 1 })).toEqual({ color, revision: 1 });
    }
    expect(createRankRequestSchema.safeParse({ rankSystemId: id, name: 'Rank', position: 0, subRanks: [], criteria: [] }).success).toBe(true);
    for (const color of ['red', '#abc', '#12345678', '#gg0000', '123456']) {
      expect(rankSchema.safeParse({ ...rank, color }).success).toBe(false);
      expect(updateRankRequestSchema.safeParse({ color, revision: 1 }).success).toBe(false);
    }
  });
  it('matches the locked schema while keeping append-only history revision-free', () => {
    expect(programSchema.parse(program)).toEqual(program);
    expect(rankSchema.parse(rank)).toEqual(rank);
    expect(rankSystemSchema.parse({ ...base, name: 'Ranks', installedPackId: null }).revision).toBe(1);
    expect(promotionSchema.parse(appendOnlyPromotion).rankSystemId).toBe(id);
    expect(promotionSchema.safeParse(promotion).success).toBe(false);
    expectTypeOf<Program>().toExtend<WireRow<typeof programs.$inferSelect>>();
    expectTypeOf<Rank>().toExtend<WireRow<typeof ranks.$inferSelect>>();
    expectTypeOf<RankSystem>().toExtend<WireRow<typeof rankSystems.$inferSelect>>();
    expectTypeOf<Promotion>().toExtend<Omit<typeof memberRanks.$inferSelect, 'createdAt' | 'promotedAt'>
      & { createdAt: string; promotedAt: string }>();
    expectTypeOf<InstalledPack>().toExtend<WireRow<typeof installedPacks.$inferSelect>>();
  });
  it('requires positive revisions for every editable record and forbids changing a rank system on a rank', () => {
    for (const schema of [updateProgramRequestSchema, updateRankRequestSchema, updateRankSystemRequestSchema]) {
      expect(schema.safeParse({ name: 'Renamed' }).success).toBe(false);
      expect(schema.safeParse({ name: 'Renamed', revision: 0 }).success).toBe(false);
      expect(schema.parse({ name: 'Renamed', revision: 2 }).revision).toBe(2);
    }
    expect(updateRankRequestSchema.safeParse({ rankSystemId: otherId, revision: 2 }).success).toBe(false);
    expect(updateProgramRequestSchema.safeParse({ revision: 1 }).success).toBe(false);
  });
  it('supports provider-owned eligibility config and rejects duplicate sub-rank IDs or negative positions', () => {
    expect(rankSchema.parse({ ...rank, criteria: [{ providerId: 'classes_since_promotion', config: { target: 100 } }] })
      .criteria[0]?.config).toEqual({ target: 100 });
    expect(rankSchema.safeParse({ ...rank, position: -1 }).success).toBe(false);
    expect(rankSchema.safeParse({ ...rank, subRanks: [{ id: 'one', name: 'One' }, { id: 'one', name: 'Again' }] }).success).toBe(false);
  });
  it('rejects resolved cross-system promotions and eligibility inconsistent with provider results', () => {
    const eligibility = { memberId: id, rankSystemId: id, program: { id, rankSystemId: id },
      rank: { id: otherId, rankSystemId: id }, subRank: 0, eligible: false,
      criteria: [{ providerId: 'classes_since_promotion', labelKey: 'ranks.classes', current: 84, target: 100, met: false }] };
    expect(promotionEligibilitySchema.parse(eligibility).eligible).toBe(false);
    expect(promotionEligibilitySchema.safeParse({ ...eligibility, rank: { id, rankSystemId: otherId } }).success).toBe(false);
    expect(promotionEligibilitySchema.safeParse({ ...eligibility, program: { id, rankSystemId: otherId } }).success).toBe(false);
    expect(promotionEligibilitySchema.safeParse({ ...eligibility, eligible: true }).success).toBe(false);
  });
  it('rejects an empty or repeated-member bulk promotion', () => {
    const request = { memberIds: [id], programId: id, rankId: id, rankSystemId: id, subRank: 0, promotedAt: now };
    expect(bulkPromoteRequestSchema.parse(request).memberIds).toEqual([id]);
    expect(bulkPromoteRequestSchema.safeParse({ ...request, memberIds: [] }).success).toBe(false);
    expect(bulkPromoteRequestSchema.safeParse({ ...request, memberIds: [id, id] }).success).toBe(false);
  });
  it('uses the existing pack format and rejects broken program references', () => {
    const pack = { version: 1, id: 'general', name: 'General', rankSystems: [], programs: [], classTags: [] };
    expect(applyContentPackRequestSchema.parse({ pack }).pack).toEqual(pack);
    expect(applyContentPackRequestSchema.safeParse({ pack: { ...pack, version: 2 } }).success).toBe(false);
    expect(applyContentPackRequestSchema.safeParse({ pack: { ...pack,
      programs: [{ id: 'adults', name: 'Adults', rankSystemId: 'missing' }] } }).success).toBe(false);
  });
  it('extends the shared strict pagination with unambiguous filters', () => {
    expect(programListQuerySchema.parse({ active: 'false', offset: '10' })).toEqual({ limit: 50, offset: 10, active: false });
    expect(programListQuerySchema.safeParse({ active: '0' }).success).toBe(false);
    expect(programListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(programListQuerySchema.safeParse({ unscoped: true }).success).toBe(false);
  });
  it.each(Object.entries(ranksContracts))('%s declares its allowed and denied roles', (operation, contract) => {
    if (contract.permission.kind === 'public') {
      expect(operation).toBe('catalog');
      return;
    }
    const expected = ['promote', 'bulkPromote', 'eligibility'].includes(operation)
      ? ['owner', 'admin', 'coach']
      : ['listPrograms', 'listRankSystems', 'listRanks', 'listPromotions'].includes(operation)
        ? ['owner', 'admin', 'coach', 'front_desk'] : ['owner', 'admin'];
    for (const role of staffRoles) expect(canStaff([role], contract.permission.capability)).toBe(expected.includes(role));
  });
});
