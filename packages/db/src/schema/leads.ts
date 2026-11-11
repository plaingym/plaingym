// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { check, date, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth.js';
import { base, choice, instant, ref, revision, revisionCheck, scoped } from './common.js';
import { members } from './members.js';

export const leads = pgTable('leads', {
  ...base(),
  memberId: uuid('member_id').notNull(),
  source: text('source'),
  stage: text('stage').notNull().default('new'),
  lostReason: text('lost_reason'),
  nextFollowUpOn: date('next_follow_up_on'),
  lastContactedAt: instant('last_contacted_at'),
  trialAttendedAt: instant('trial_attended_at'),
  wonAt: instant('won_at'),
  lostAt: instant('lost_at'),
  ...revision(),
}, (t) => [
  ...scoped('leads', t),
  ref('leads_member_fk', t.gymId, t.memberId, members),
  unique('leads_member_key').on(t.gymId, t.memberId),
  choice('leads_source_check', t.source, ['trial_form', 'join', 'drop_in', 'walk_in', 'referral', 'phone', 'other']),
  choice('leads_stage_check', t.stage, ['new', 'contacted', 'trial_booked', 'trial_attended', 'won', 'lost']),
  check('leads_lost_reason_check', sql`char_length(${t.lostReason}) <= 500`),
  check('leads_lost_at_check', sql`${t.stage} <> 'lost' or ${t.lostAt} is not null`),
  check('leads_won_at_check', sql`${t.stage} <> 'won' or ${t.wonAt} is not null`),
  revisionCheck('leads_revision_check', t.revision),
  index('leads_stage_idx').on(t.gymId, t.stage),
  index('leads_follow_up_idx').on(t.gymId, t.nextFollowUpOn).where(sql`${t.stage} not in ('won', 'lost')`),
]).enableRLS();

export const leadContacts = pgTable('lead_contacts', {
  ...base(),
  leadId: uuid('lead_id').notNull(),
  occurredAt: instant('occurred_at').notNull(),
  channel: text('channel').notNull(),
  note: text('note'),
  createdBy: uuid('created_by').notNull().references(() => authUser.id),
}, (t) => [
  ...scoped('lead_contacts', t),
  ref('lead_contacts_lead_fk', t.gymId, t.leadId, leads),
  choice('lead_contacts_channel_check', t.channel, ['call', 'text', 'email', 'in_person', 'other']),
  check('lead_contacts_note_check', sql`char_length(${t.note}) <= 2000`),
  index('lead_contacts_lead_idx').on(t.gymId, t.leadId, t.occurredAt),
]).enableRLS();
