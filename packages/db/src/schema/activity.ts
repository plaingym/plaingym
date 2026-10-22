// SPDX-License-Identifier: AGPL-3.0-only
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth.js';
import { base, choice, instant, scoped } from './common.js';
export const auditEvents = pgTable('audit_events', {
  ...base(), actorId: uuid('actor_id').references(() => authUser.id), actorKind: text('actor_kind').notNull(),
  action: text('action').notNull(), targetType: text('target_type').notNull(), targetId: uuid('target_id').notNull(),
  before: jsonb('before'), after: jsonb('after'), occurredAt: instant('occurred_at').notNull(),
}, (t) => [...scoped('audit_events', t), index('audit_events_gym_time_idx').on(t.gymId, t.occurredAt),
  choice('audit_events_actor_check', t.actorKind, ['user', 'system', 'device'])]).enableRLS();
export const emailOutbox = pgTable('email_outbox', {
  ...base(), recipient: text('recipient').notNull(), subject: text('subject').notNull(),
  html: text('html').notNull(), text: text('text').notNull(), sentAt: instant('sent_at').notNull(),
}, (t) => [...scoped('email_outbox', t), index('email_outbox_gym_time_idx').on(t.gymId, t.sentAt)]).enableRLS();
