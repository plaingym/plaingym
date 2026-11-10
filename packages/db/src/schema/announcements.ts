// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth.js';
import { base, choice, instant, ref, scoped } from './common.js';
import { members } from './members.js';

export const announcements = pgTable('announcements', {
  ...base(),
  createdBy: uuid('created_by').notNull().references(() => authUser.id),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  audience: jsonb('audience').$type<{ statuses: ('active' | 'trial' | 'frozen')[]; programIds: string[] }>().notNull(),
  recipientCount: integer('recipient_count').notNull().default(0),
  status: text('status').notNull().default('sending'),
  completedAt: instant('completed_at'),
}, (t) => [
  ...scoped('announcements', t),
  check('announcements_subject_check', sql`char_length(${t.subject}) between 1 and 150`),
  check('announcements_body_check', sql`char_length(${t.body}) between 1 and 10000`),
  check('announcements_audience_check', sql`jsonb_typeof(${t.audience}) = 'object'
    and coalesce(jsonb_typeof(${t.audience}->'statuses') = 'array', false)
    and coalesce(jsonb_typeof(${t.audience}->'programIds') = 'array', false)`),
  check('announcements_recipient_count_check', sql`${t.recipientCount} >= 0`),
  choice('announcements_status_check', t.status, ['sending', 'sent']),
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
