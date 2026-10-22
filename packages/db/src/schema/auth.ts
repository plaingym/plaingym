// SPDX-License-Identifier: AGPL-3.0-only
import { bigint, boolean, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../id.js';
import { instant } from './common.js';
import { gyms } from './gyms.js';
const identity = () => ({
  id: uuid('id').primaryKey().$defaultFn(uuidv7),
  createdAt: instant('created_at').notNull().defaultNow(), updatedAt: instant('updated_at').notNull().defaultNow(),
});
export const authUser = pgTable('auth_user', {
  ...identity(), name: text('name').notNull(), email: text('email').notNull(),
  emailVerified: boolean('email_verified').notNull().default(false), image: text('image'),
}, (t) => [unique('auth_user_email_key').on(t.email)]);
export const authSession = pgTable('auth_session', {
  ...identity(), gymId: uuid('gym_id').notNull().references(() => gyms.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => authUser.id, { onDelete: 'cascade' }),
  token: text('token').notNull(), expiresAt: instant('expires_at').notNull(),
  ipAddress: text('ip_address'), userAgent: text('user_agent'),
}, (t) => [unique('auth_session_token_key').on(t.token), index('auth_session_gym_user_idx').on(t.gymId, t.userId)]);
export const authAccount = pgTable('auth_account', {
  ...identity(), userId: uuid('user_id').notNull().references(() => authUser.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(), providerId: text('provider_id').notNull(),
  accessToken: text('access_token'), refreshToken: text('refresh_token'), idToken: text('id_token'),
  accessTokenExpiresAt: instant('access_token_expires_at'), refreshTokenExpiresAt: instant('refresh_token_expires_at'),
  scope: text('scope'), password: text('password'),
}, (t) => [unique('auth_account_provider_account_key').on(t.providerId, t.accountId), index('auth_account_user_idx').on(t.userId)]);
export const authVerification = pgTable('auth_verification', {
  ...identity(), identifier: text('identifier').notNull(), value: text('value').notNull(), expiresAt: instant('expires_at').notNull(),
}, (t) => [index('auth_verification_identifier_idx').on(t.identifier)]);
export const authRateLimit = pgTable('auth_rate_limit', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7), key: text('key').notNull(), count: integer('count').notNull(),
  // Better Auth stores rate-limit time as epoch milliseconds.
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
}, (t) => [unique('auth_rate_limit_key_key').on(t.key)]);
