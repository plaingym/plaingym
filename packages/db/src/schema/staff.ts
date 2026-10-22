// SPDX-License-Identifier: AGPL-3.0-only
import { boolean, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth.js';
import { base, choice, ref, scoped } from './common.js';
import { members } from './members.js';
export const staffRoles = pgTable('staff_roles', {
  ...base(), userId: uuid('user_id').notNull().references(() => authUser.id), role: text('role').notNull(),
}, (t) => [...scoped('staff_roles', t), unique('staff_roles_gym_user_key').on(t.gymId, t.userId),
  choice('staff_roles_role_check', t.role, ['owner', 'admin', 'coach', 'front_desk'])]).enableRLS();
export const staffProfiles = pgTable('staff_profiles', {
  ...base(), userId: uuid('user_id').notNull().references(() => authUser.id), memberId: uuid('member_id'),
  displayName: text('display_name').notNull(), bio: text('bio'), photoKey: text('photo_key'), rank: text('rank'),
  isPublic: boolean('is_public').notNull().default(false),
}, (t) => [...scoped('staff_profiles', t), unique('staff_profiles_gym_user_key').on(t.gymId, t.userId),
  ref('staff_profiles_member_fk', t.gymId, t.memberId, members)]).enableRLS();
