// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../id.js';
export const gyms = pgTable('gyms', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7),
  name: text('name').notNull(), slug: text('slug').notNull(),
  status: text('status').notNull().default('active'), timezone: text('timezone').notNull().default('UTC'),
  address: jsonb('address').notNull().default({}), branding: jsonb('branding').notNull().default({}),
  websiteEnabled: boolean('website_enabled').notNull().default(false), existingSiteUrl: text('existing_site_url'),
  stripeConfig: text('stripe_config_encrypted'), smtpConfig: text('smtp_config_encrypted'),
  s3Config: text('s3_config_encrypted'), qrKey: text('qr_key_encrypted'),
  backupDestination: jsonb('backup_destination'), backupPublicKey: text('backup_public_key'),
  backupBlobKey: text('backup_blob_key_encrypted'),
  backupRetentionBytes: bigint('backup_retention_bytes', { mode: 'bigint' }),
  billingEnabled: boolean('billing_enabled').notNull().default(false),
  memberEmailsEnabled: boolean('member_emails_enabled').notNull().default(false),
  bookingWindowDays: integer('booking_window_days').notNull().default(14),
  cancellationCutoffMinutes: integer('cancellation_cutoff_minutes').notNull().default(60),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('gyms_slug_key').on(t.slug),
  check('gyms_status_check', sql`${t.status} in ('active', 'suspended')`),
  check('gyms_limits_check', sql`${t.bookingWindowDays} >= 0 and ${t.cancellationCutoffMinutes} >= 0 and ${t.backupRetentionBytes} >= 0`),
]);
export const gymDomains = pgTable('gym_domains', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7),
  gymId: uuid('gym_id').notNull().references(() => gyms.id, { onDelete: 'cascade' }),
  hostname: text('hostname').notNull(), kind: text('kind').notNull().default('custom'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
}, (t) => [
  unique('gym_domains_hostname_key').on(t.hostname),
  unique('gym_domains_gym_id_id_key').on(t.gymId, t.id),
  check('gym_domains_kind_check', sql`${t.kind} in ('default', 'custom')`),
  check('gym_domains_hostname_check', sql`${t.hostname} = lower(${t.hostname}) and ${t.hostname} <> ''`),
]);
