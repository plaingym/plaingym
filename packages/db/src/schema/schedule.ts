// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth.js';
import { base, choice, instant, ref, revision, revisionCheck, scoped } from './common.js';
import { members } from './members.js';
import { programs } from './ranks.js';
import { staffProfiles } from './staff.js';
export const classTags = pgTable('class_tags', {
  ...base(), name: text('name').notNull(), ...revision(),
}, (t) => [...scoped('class_tags', t), unique('class_tags_name_key').on(t.gymId, t.name),
  revisionCheck('class_tags_revision_check', t.revision)]).enableRLS();
export const classTemplates = pgTable('class_templates', {
  ...base(), name: text('name').notNull(), weekday: integer('weekday').notNull(),
  localStartTime: text('local_start_time').notNull(), durationMinutes: integer('duration_minutes').notNull(),
  coachId: uuid('coach_id'), capacity: integer('capacity'), notes: text('notes'),
  kind: text('kind').notNull().default('class'), ...revision(),
}, (t) => [...scoped('class_templates', t), revisionCheck('class_templates_revision_check', t.revision), ref('class_templates_coach_fk', t.gymId, t.coachId, staffProfiles),
  check('class_templates_schedule_check', sql`${t.weekday} between 0 and 6 and ${t.durationMinutes} > 0 and ${t.localStartTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  check('class_templates_capacity_check', sql`${t.capacity} > 0`),
  choice('class_templates_kind_check', t.kind, ['class', 'open_mat'])]).enableRLS();
export const classTemplatePrograms = pgTable('class_template_programs', {
  ...base(), templateId: uuid('template_id').notNull(), programId: uuid('program_id').notNull(),
}, (t) => [...scoped('class_template_programs', t), ref('class_template_programs_template_fk', t.gymId, t.templateId, classTemplates),
  ref('class_template_programs_program_fk', t.gymId, t.programId, programs),
  unique('class_template_programs_pair_key').on(t.gymId, t.templateId, t.programId)]).enableRLS();
export const classTemplateTags = pgTable('class_template_tags', {
  ...base(), templateId: uuid('template_id').notNull(), tagId: uuid('tag_id').notNull(),
}, (t) => [...scoped('class_template_tags', t), ref('class_template_tags_template_fk', t.gymId, t.templateId, classTemplates),
  ref('class_template_tags_tag_fk', t.gymId, t.tagId, classTags),
  unique('class_template_tags_pair_key').on(t.gymId, t.templateId, t.tagId)]).enableRLS();
export const classSessions = pgTable('class_sessions', {
  ...base(), templateId: uuid('template_id'), name: text('name').notNull(),
  startsAt: instant('starts_at').notNull(), endsAt: instant('ends_at').notNull(),
  coachId: uuid('coach_id'), capacity: integer('capacity'), notes: text('notes'),
  status: text('status').notNull().default('scheduled'), kind: text('kind').notNull().default('class'), ...revision(),
}, (t) => [...scoped('class_sessions', t), revisionCheck('class_sessions_revision_check', t.revision),
  index('class_sessions_gym_starts_idx').on(t.gymId, t.startsAt), ref('class_sessions_template_fk', t.gymId, t.templateId, classTemplates),
  ref('class_sessions_coach_fk', t.gymId, t.coachId, staffProfiles),
  unique('class_sessions_materialized_key').on(t.gymId, t.templateId, t.startsAt),
  check('class_sessions_times_check', sql`${t.endsAt} > ${t.startsAt}`),
  check('class_sessions_capacity_check', sql`${t.capacity} > 0`),
  choice('class_sessions_status_check', t.status, ['scheduled', 'cancelled']),
  choice('class_sessions_kind_check', t.kind, ['class', 'open_mat'])]).enableRLS();
export const classSessionPrograms = pgTable('class_session_programs', {
  ...base(), sessionId: uuid('session_id').notNull(), programId: uuid('program_id').notNull(),
}, (t) => [...scoped('class_session_programs', t), ref('class_session_programs_session_fk', t.gymId, t.sessionId, classSessions),
  ref('class_session_programs_program_fk', t.gymId, t.programId, programs),
  unique('class_session_programs_pair_key').on(t.gymId, t.sessionId, t.programId)]).enableRLS();
export const classSessionTags = pgTable('class_session_tags', {
  ...base(), sessionId: uuid('session_id').notNull(), tagId: uuid('tag_id').notNull(),
}, (t) => [...scoped('class_session_tags', t), ref('class_session_tags_session_fk', t.gymId, t.sessionId, classSessions),
  ref('class_session_tags_tag_fk', t.gymId, t.tagId, classTags),
  unique('class_session_tags_pair_key').on(t.gymId, t.sessionId, t.tagId)]).enableRLS();
export const attendances = pgTable('attendances', {
  ...base(), memberId: uuid('member_id').notNull(), sessionId: uuid('session_id'),
  programId: uuid('program_id'), occurredAt: instant('occurred_at').notNull(), source: text('source').notNull(),
  sourceKey: text('source_key'),
  // Copied from the session when recorded (session-less visits are open mat), so later edits never reclassify it.
  kind: text('kind').notNull().default('class'),
}, (t) => [...scoped('attendances', t), ref('attendances_member_fk', t.gymId, t.memberId, members),
  ref('attendances_session_fk', t.gymId, t.sessionId, classSessions), ref('attendances_program_fk', t.gymId, t.programId, programs),
  unique('attendances_session_member_key').on(t.gymId, t.sessionId, t.memberId),
  unique('attendances_source_key').on(t.gymId, t.sourceKey),
  index('attendances_member_time_idx').on(t.gymId, t.memberId, t.occurredAt),
  choice('attendances_source_check', t.source, ['kiosk', 'coach', 'import']),
  choice('attendances_kind_check', t.kind, ['class', 'open_mat'])]).enableRLS();
export const classBookings = pgTable('class_bookings', {
  ...base(), memberId: uuid('member_id').notNull(), sessionId: uuid('session_id').notNull(),
  status: text('status').notNull().default('booked'), waitlistPosition: integer('waitlist_position'),
  bookedBy: uuid('booked_by').notNull().references(() => authUser.id),
  bookedByKind: text('booked_by_kind').notNull(), cancelledAt: instant('cancelled_at'),
}, (t) => [...scoped('class_bookings', t), ref('class_bookings_member_fk', t.gymId, t.memberId, members),
  ref('class_bookings_session_fk', t.gymId, t.sessionId, classSessions),
  uniqueIndex('class_bookings_active_key').on(t.gymId, t.sessionId, t.memberId).where(sql`${t.status} <> 'cancelled'`),
  index('class_bookings_member_idx').on(t.gymId, t.memberId, t.sessionId),
  // Waitlist positions keep gaps: allocate max + 1 under the session lock and promote the lowest; never renumber.
  uniqueIndex('class_bookings_waitlist_key').on(t.gymId, t.sessionId, t.waitlistPosition).where(sql`${t.status} = 'waitlisted'`),
  choice('class_bookings_status_check', t.status, ['booked', 'waitlisted', 'cancelled']),
  choice('class_bookings_actor_check', t.bookedByKind, ['member', 'staff']),
  check('class_bookings_waitlist_check', sql`(${t.status} = 'waitlisted' and ${t.waitlistPosition} is not null and ${t.waitlistPosition} > 0) or (${t.status} <> 'waitlisted' and ${t.waitlistPosition} is null)`),
]).enableRLS();
