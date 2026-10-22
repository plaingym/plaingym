// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { check, foreignKey, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth.js';
import { invoices } from './billing.js';
import { base, choice, instant, ref, scoped, sha256Check } from './common.js';
import { households, members } from './members.js';
export const kioskDevices = pgTable('kiosk_devices', {
  ...base(), name: text('name').notNull(), tokenHash: text('token_hash').notNull(),
  revokedAt: instant('revoked_at'), lastSeenAt: instant('last_seen_at'),
}, (t) => [...scoped('kiosk_devices', t), unique('kiosk_devices_hash_key').on(t.gymId, t.tokenHash),
  sha256Check('kiosk_devices_hash_check', t.tokenHash)]).enableRLS();
export const linkCampaigns = pgTable('link_campaigns', {
  ...base(), name: text('name').notNull(), purpose: text('purpose').notNull(),
  createdBy: uuid('created_by').references(() => authUser.id),
  reminderSchedule: jsonb('reminder_schedule').notNull().default([]), completedAt: instant('completed_at'),
}, (t) => [...scoped('link_campaigns', t), choice('link_campaigns_purpose_check', t.purpose, ['onboarding', 'pay_invoice', 'update_card', 'sign_waiver'])]).enableRLS();
export const signedLinks = pgTable('signed_links', {
  ...base(), householdId: uuid('household_id').notNull(), tokenHash: text('token_hash').notNull(),
  purpose: text('purpose').notNull(), invoiceId: uuid('invoice_id'), memberId: uuid('member_id'), campaignId: uuid('campaign_id'),
  expiresAt: instant('expires_at').notNull(), usedAt: instant('used_at'), revokedAt: instant('revoked_at'),
  createdBy: uuid('created_by').references(() => authUser.id),
}, (t) => [...scoped('signed_links', t), ref('signed_links_household_fk', t.gymId, t.householdId, households),
  ref('signed_links_campaign_fk', t.gymId, t.campaignId, linkCampaigns),
  foreignKey({ name: 'signed_links_invoice_fk', columns: [t.gymId, t.householdId, t.invoiceId],
    foreignColumns: [invoices.gymId, invoices.householdId, invoices.id] }),
  foreignKey({ name: 'signed_links_member_fk', columns: [t.gymId, t.householdId, t.memberId],
    foreignColumns: [members.gymId, members.householdId, members.id] }),
  unique('signed_links_hash_key').on(t.gymId, t.tokenHash),
  choice('signed_links_purpose_check', t.purpose, ['onboarding', 'pay_invoice', 'update_card', 'sign_waiver']),
  check('signed_links_resource_check', sql`
    (${t.purpose} = 'pay_invoice' and ${t.invoiceId} is not null and ${t.memberId} is null)
    or (${t.purpose} = 'sign_waiver' and ${t.memberId} is not null and ${t.invoiceId} is null)
    or (${t.purpose} in ('update_card', 'onboarding') and ${t.invoiceId} is null and ${t.memberId} is null)
  `),
  sha256Check('signed_links_hash_check', t.tokenHash)]).enableRLS();
