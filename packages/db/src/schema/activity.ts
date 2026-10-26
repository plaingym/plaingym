// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
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
