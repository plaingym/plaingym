// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth.js';
import { base, choice, instant, ref, scoped } from './common.js';
import { members } from './members.js';

export const announcements = pgTable('announcements', {
  ...base(),
  sendGeneration: uuid('send_generation').notNull(),
  createdBy: uuid('created_by').notNull().references(() => authUser.id),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  audience: jsonb('audience').$type<{ statuses: ('active' | 'trial' | 'frozen')[]; programIds: string[] }>().notNull(),
  recipientCount: integer('recipient_count').notNull().default(0),
  smsBody: text('sms_body'),
  smsRecipientCount: integer('sms_recipient_count').notNull().default(0),
  smsSent: integer('sms_sent').notNull().default(0),
  smsFailed: integer('sms_failed').notNull().default(0),
  smsSkipped: integer('sms_skipped').notNull().default(0),
  smsScheduledFor: instant('sms_scheduled_for'),
  smsCompletedAt: instant('sms_completed_at'),
  status: text('status').notNull().default('sending'),
  completedAt: instant('completed_at'),
}, (t) => [
  ...scoped('announcements', t),
  unique('announcements_generation_key').on(t.gymId, t.sendGeneration),
  check('announcements_completion_check', sql`(${t.status} = 'sent') = (${t.completedAt} is not null)`),
  check('announcements_subject_check', sql`char_length(${t.subject}) between 1 and 150`),
  check('announcements_body_check', sql`char_length(${t.body}) between 1 and 10000`),
  check('announcements_audience_check', sql`jsonb_typeof(${t.audience}) = 'object'
    and coalesce(jsonb_typeof(${t.audience}->'statuses') = 'array', false)
    and coalesce(jsonb_typeof(${t.audience}->'programIds') = 'array', false)`),
  check('announcements_recipient_count_check', sql`${t.recipientCount} >= 0`),
  check('announcements_sms_counts_check', sql`${t.smsRecipientCount} >= 0 and ${t.smsSent} >= 0 and ${t.smsFailed} >= 0 and ${t.smsSkipped} >= 0`),
  check('announcements_sms_body_check', sql`${t.smsBody} is null or char_length(${t.smsBody}) between 1 and 480`),
  choice('announcements_status_check', t.status, ['sending', 'sent']),
]).enableRLS();

/** Independent text outcomes leave existing email recipients and their lifecycle unchanged. */
export const announcementSmsRecipients = pgTable('announcement_sms_recipients', {
  ...base(),
  announcementId: uuid('announcement_id').notNull(),
  memberId: uuid('member_id').notNull(),
  memberIds: jsonb('member_ids').$type<string[]>().notNull(),
  phoneDigest: text('phone_digest'),
  state: text('state').notNull().default('pending'),
  reason: text('reason'),
  updatedAt: instant('updated_at').notNull().defaultNow(),
}, (t) => [
  ...scoped('announcement_sms_recipients', t),
  ref('announcement_sms_recipients_announcement_fk', t.gymId, t.announcementId, announcements),
  ref('announcement_sms_recipients_member_fk', t.gymId, t.memberId, members),
  unique('announcement_sms_recipients_member_key').on(t.gymId, t.announcementId, t.memberId),
  index('announcement_sms_recipients_scan_idx').on(t.gymId, t.announcementId, t.state, t.id),
  index('announcement_sms_recipients_member_idx').on(t.gymId, t.memberId),
  choice('announcement_sms_recipients_state_check', t.state, ['pending', 'sent', 'failed', 'skipped']),
  check('announcement_sms_recipients_members_check', sql`jsonb_typeof(${t.memberIds}) = 'array' and jsonb_array_length(${t.memberIds}) > 0`),
  check('announcement_sms_recipients_outcome_check', sql`(${t.state} in ('failed', 'skipped')) = (${t.reason} is not null)`),
  choice('announcement_sms_recipients_reason_check', t.reason, [
    'ineligible', 'duplicate_phone', 'disabled', 'no_provider', 'no_consent', 'phone_changed', 'cap_reached', 'not_accepted', 'unknown',
  ]),
]).enableRLS();

export const announcementRecipients = pgTable('announcement_recipients', {
  ...base(),
  announcementId: uuid('announcement_id').notNull(),
  memberId: uuid('member_id').notNull(),
  state: text('state').notNull().default('pending'),
  // Safe classifications only; never an address, rendered body or SMTP reply.
  reason: text('reason'),
  updatedAt: instant('updated_at').notNull().defaultNow(),
}, (t) => [
  ...scoped('announcement_recipients', t),
  ref('announcement_recipients_announcement_fk', t.gymId, t.announcementId, announcements),
  ref('announcement_recipients_member_fk', t.gymId, t.memberId, members),
  unique('announcement_recipients_member_key').on(t.gymId, t.announcementId, t.memberId),
  index('announcement_recipients_scan_idx').on(t.gymId, t.announcementId, t.state, t.id),
  index('announcement_recipients_member_idx').on(t.gymId, t.memberId),
  check('announcement_recipients_outcome_check', sql`(${t.state} in ('failed', 'skipped')) = (${t.reason} is not null)`),
  choice('announcement_recipients_state_check', t.state, ['pending', 'sent', 'failed', 'skipped']),
  choice('announcement_recipients_reason_check', t.reason, [
    'opt_out', 'undeliverable', 'disabled', 'anonymized', 'ineligible', 'missing_email',
    'duplicate_address', 'not_accepted', 'unknown',
  ]),
]).enableRLS();

export const announcementOptOuts = pgTable('announcement_opt_outs', {
  ...base(), memberId: uuid('member_id').notNull(),
}, (t) => [
  ...scoped('announcement_opt_outs', t),
  ref('announcement_opt_outs_member_fk', t.gymId, t.memberId, members),
  unique('announcement_opt_outs_member_key').on(t.gymId, t.memberId),
]).enableRLS();
