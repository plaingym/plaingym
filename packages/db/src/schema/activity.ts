// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { check, date, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth.js';
import { base, choice, instant, ref, scoped } from './common.js';
import { kioskDevices } from './links.js';
/** The actor is a user, a kiosk device, or the system; each kind sets exactly its own reference. */
export const auditEvents = pgTable('audit_events', {
  ...base(), actorKind: text('actor_kind').notNull(),
  actorUserId: uuid('actor_user_id').references(() => authUser.id), actorDeviceId: uuid('actor_device_id'),
  action: text('action').notNull(), targetType: text('target_type').notNull(), targetId: uuid('target_id').notNull(),
  before: jsonb('before'), after: jsonb('after'), occurredAt: instant('occurred_at').notNull(),
}, (t) => [...scoped('audit_events', t), index('audit_events_gym_time_idx').on(t.gymId, t.occurredAt),
  index('audit_events_gym_action_target_idx').on(t.gymId, t.action, t.targetId),
  ref('audit_events_device_fk', t.gymId, t.actorDeviceId, kioskDevices),
  choice('audit_events_actor_check', t.actorKind, ['user', 'system', 'device']),
  check('audit_events_actor_reference_check', sql`(${t.actorKind} = 'user' and ${t.actorUserId} is not null and ${t.actorDeviceId} is null)
    or (${t.actorKind} = 'device' and ${t.actorDeviceId} is not null and ${t.actorUserId} is null)
    or (${t.actorKind} = 'system' and ${t.actorUserId} is null and ${t.actorDeviceId} is null)`)]).enableRLS();
export const emailOutbox = pgTable('email_outbox', {
  ...base(), recipient: text('recipient').notNull(), subject: text('subject').notNull(),
  html: text('html').notNull(), text: text('text').notNull(), sentAt: instant('sent_at').notNull(),
}, (t) => [...scoped('email_outbox', t), index('email_outbox_gym_time_idx').on(t.gymId, t.sentAt)]).enableRLS();
/**
 * Durable send state per caller idempotency key. `sending` marks an attempt in flight and counts as `unknown` once
 * stale, so a crash never permits a resend; only `not_accepted` (proof no recipient received it) may be retried.
 * Rows are kept permanently.
 */
export const emailDeliveries = pgTable('email_deliveries', {
  ...base(), key: text('key').notNull(), state: text('state').notNull(), attempts: integer('attempts').notNull().default(1),
  // Set only on a send command's row: what the request was, and what a replay of it returns.
  commandDigest: text('command_digest'), commandResult: jsonb('command_result'),
  updatedAt: instant('updated_at').notNull(),
}, (t) => [...scoped('email_deliveries', t), unique('email_deliveries_key_key').on(t.gymId, t.key),
  index('email_deliveries_command_idx').on(t.gymId, t.commandDigest),
  choice('email_deliveries_state_check', t.state, ['sending', 'accepted', 'unknown', 'not_accepted']),
  check('email_deliveries_key_check', sql`char_length(${t.key}) between 1 and 300`),
  check('email_deliveries_attempts_check', sql`${t.attempts} > 0`)]).enableRLS();

/** Durable at-most-once state. Keys and command results contain identifiers, never text or phone numbers. */
export const smsDeliveries = pgTable('sms_deliveries', {
  ...base(), key: text('key').notNull(), state: text('state').notNull(), attempts: integer('attempts').notNull().default(1),
  commandDigest: text('command_digest'), commandResult: jsonb('command_result'), updatedAt: instant('updated_at').notNull(),
}, (t) => [...scoped('sms_deliveries', t), unique('sms_deliveries_key_key').on(t.gymId, t.key),
  index('sms_deliveries_command_idx').on(t.gymId, t.commandDigest),
  choice('sms_deliveries_state_check', t.state, ['sending', 'accepted', 'unknown', 'not_accepted']),
  check('sms_deliveries_key_check', sql`char_length(${t.key}) between 1 and 300 and ${t.key} ~ '^[A-Za-z0-9_.:-]+$'`),
  check('sms_deliveries_attempts_check', sql`${t.attempts} > 0`)]).enableRLS();
/** Slots are charged before delivery; failures retain their slot to bound retries and uncertain sends. */
export const smsDailyUsage = pgTable('sms_daily_usage', {
  ...base(), day: date('day').notNull(), sent: integer('sent').notNull().default(0), refused: integer('refused').notNull().default(0),
}, (t) => [...scoped('sms_daily_usage', t), unique('sms_daily_usage_day_key').on(t.gymId, t.day),
  check('sms_daily_usage_counts_check', sql`${t.sent} >= 0 and ${t.refused} >= 0`)]).enableRLS();
/** Numbers that replied STOP, one row per gym and number, until consent is recorded for the number again. */
export const smsOptedOutNumbers = pgTable('sms_opted_out_numbers', {
  ...base(), phoneE164: text('phone_e164').notNull(), optedOutAt: instant('opted_out_at').notNull(),
}, (t) => [...scoped('sms_opted_out_numbers', t), unique('sms_opted_out_numbers_phone_key').on(t.gymId, t.phoneE164),
  check('sms_opted_out_numbers_phone_e164_check', sql`${t.phoneE164} ~ '^[+][1-9][0-9]{1,14}$'`)]).enableRLS();
export const smsOutbox = pgTable('sms_outbox', {
  ...base(), recipient: text('recipient').notNull(), body: text('body').notNull(), sentAt: instant('sent_at').notNull(),
}, (t) => [...scoped('sms_outbox', t), index('sms_outbox_gym_time_idx').on(t.gymId, t.sentAt)]).enableRLS();
