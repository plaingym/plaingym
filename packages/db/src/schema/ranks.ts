// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { base, instant, ref, scoped } from './common.js';
import { members } from './members.js';
import { staffProfiles } from './staff.js';
export const installedPacks = pgTable('installed_packs', {
  ...base(), packId: text('pack_id').notNull(), version: integer('version').notNull(),
}, (t) => [...scoped('installed_packs', t), unique('installed_packs_version_key').on(t.gymId, t.packId, t.version),
  check('installed_packs_version_check', sql`${t.version} > 0`)]).enableRLS();
export const rankSystems = pgTable('rank_systems', {
  ...base(), name: text('name').notNull(), installedPackId: uuid('installed_pack_id'),
}, (t) => [...scoped('rank_systems', t), ref('rank_systems_pack_fk', t.gymId, t.installedPackId, installedPacks)]).enableRLS();
export const programs = pgTable('programs', {
  ...base(), name: text('name').notNull(), rankSystemId: uuid('rank_system_id'), active: boolean('active').notNull().default(true),
}, (t) => [...scoped('programs', t), unique('programs_gym_name_key').on(t.gymId, t.name),
  ref('programs_rank_system_fk', t.gymId, t.rankSystemId, rankSystems)]).enableRLS();
export const ranks = pgTable('ranks', {
  ...base(), rankSystemId: uuid('rank_system_id').notNull(), name: text('name').notNull(), position: integer('position').notNull(),
  subRanks: jsonb('sub_ranks').notNull().default([]), criteria: jsonb('criteria').notNull().default([]),
}, (t) => [...scoped('ranks', t), ref('ranks_system_fk', t.gymId, t.rankSystemId, rankSystems),
  unique('ranks_gym_system_position_key').on(t.gymId, t.rankSystemId, t.position),
  check('ranks_position_check', sql`${t.position} >= 0`)]).enableRLS();
export const memberRanks = pgTable('member_ranks', {
  ...base(), memberId: uuid('member_id').notNull(), programId: uuid('program_id').notNull(), rankId: uuid('rank_id').notNull(),
  subRank: integer('sub_rank').notNull().default(0), promotedAt: instant('promoted_at').notNull(),
  promotedBy: uuid('promoted_by'), notes: text('notes'),
}, (t) => [...scoped('member_ranks', t), ref('member_ranks_member_fk', t.gymId, t.memberId, members),
  ref('member_ranks_program_fk', t.gymId, t.programId, programs), ref('member_ranks_rank_fk', t.gymId, t.rankId, ranks),
  ref('member_ranks_staff_fk', t.gymId, t.promotedBy, staffProfiles),
  check('member_ranks_sub_rank_check', sql`${t.subRank} >= 0`)]).enableRLS();
