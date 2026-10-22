// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../id.js';
import { systemAccess } from './access.js';
import { choice, instant } from './common.js';
import { gyms } from './gyms.js';
export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7),
  gymId: uuid('gym_id').references(() => gyms.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), payload: jsonb('payload').notNull().default({}),
  runAt: instant('run_at').notNull(), attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5), status: text('status').notNull().default('pending'),
  lockedUntil: instant('locked_until'), lockToken: uuid('lock_token'), lastError: text('last_error'),
  idempotencyKey: text('idempotency_key').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
}, (t) => [
  unique('jobs_idempotency_key').on(t.gymId, t.idempotencyKey).nullsNotDistinct(),
  index('jobs_claim_idx').on(t.status, t.runAt),
  index('jobs_gym_status_idx').on(t.gymId, t.status),
  choice('jobs_status_check', t.status, ['pending', 'running', 'succeeded', 'failed']),
  check('jobs_attempts_check', sql`${t.attempts} >= 0 and ${t.maxAttempts} > 0`),
  // Install-level jobs (no gym) are visible only to the worker's system context.
  ...systemAccess('jobs', 'gym', t.gymId),
]).enableRLS();
export const backupRuns = pgTable('backup_runs', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7), kind: text('kind').notNull(),
  status: text('status').notNull().default('running'), startedAt: instant('started_at').notNull(),
  completedAt: instant('completed_at'), snapshotBytes: bigint('snapshot_bytes', { mode: 'bigint' }),
  uploadBytes: bigint('upload_bytes', { mode: 'bigint' }), objectPrefix: text('object_prefix').notNull(), error: text('error'),
}, (t) => [
  unique('backup_runs_prefix_key').on(t.objectPrefix),
  choice('backup_runs_kind_check', t.kind, ['hourly', 'nightly', 'weekly', 'pre_upgrade', 'manual']),
  choice('backup_runs_status_check', t.status, ['running', 'succeeded', 'failed']),
  check('backup_runs_sizes_check', sql`${t.snapshotBytes} >= 0 and ${t.uploadBytes} >= 0`),
  ...systemAccess('backup_runs', 'system'),
]).enableRLS();
export const stripeEvents = pgTable('stripe_events', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7), eventId: text('event_id').notNull(),
  gymId: uuid('gym_id').references(() => gyms.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), payload: jsonb('payload').notNull(),
  receivedAt: instant('received_at').notNull().defaultNow(), processedAt: instant('processed_at'),
  error: text('error'),
}, (t) => [unique('stripe_events_event_key').on(t.eventId), index('stripe_events_gym_received_idx').on(t.gymId, t.receivedAt),
  ...systemAccess('stripe_events', 'gym', t.gymId)]).enableRLS();
