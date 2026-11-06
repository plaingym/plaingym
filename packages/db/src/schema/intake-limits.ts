// SPDX-License-Identifier: AGPL-3.0-only
import { index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../id.js';
import { systemAccess } from './access.js';
import { instant } from './common.js';
import { gyms } from './gyms.js';

/** Null gym means the install's demo creation endpoint, before a gym exists. */
export const intakeRateLimits = pgTable('intake_rate_limits', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7),
  gymId: uuid('gym_id').references(() => gyms.id, { onDelete: 'cascade' }),
  routeKey: text('route_key').notNull(),
  clientKey: text('client_key').notNull(),
  windowStart: instant('window_start').notNull(),
  expiresAt: instant('expires_at').notNull(),
  count: integer('count').notNull(),
}, t => [
  unique('intake_rate_limits_window_key').on(t.gymId, t.routeKey, t.clientKey, t.windowStart).nullsNotDistinct(),
  index('intake_rate_limits_expiry_idx').on(t.expiresAt),
  ...systemAccess('intake_rate_limits', 'system'),
]).enableRLS();
