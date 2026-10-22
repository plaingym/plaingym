// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth.js';
import { base, choice, instant, ref, scoped } from './common.js';
export const households = pgTable('households', {
  ...base(), name: text('name').notNull(), email: text('email'), phone: text('phone'),
  address: jsonb('address').notNull().default({}), billingDay: integer('billing_day').notNull().default(1),
  stripeCustomerId: text('stripe_customer_id'), defaultPaymentMethodId: text('default_payment_method_id'),
  pinHash: text('pin_hash'), familyDiscountBasisPoints: integer('family_discount_basis_points').notNull().default(0),
}, (t) => [
  ...scoped('households', t), unique('households_gym_stripe_customer_key').on(t.gymId, t.stripeCustomerId),
  check('households_billing_day_check', sql`${t.billingDay} between 1 and 31`),
  check('households_discount_check', sql`${t.familyDiscountBasisPoints} between 0 and 10000`),
]).enableRLS();
export const members = pgTable('members', {
  ...base(), householdId: uuid('household_id').notNull(),
  firstName: text('first_name').notNull(), lastName: text('last_name').notNull(),
  email: text('email'), phone: text('phone'), photoKey: text('photo_key'), dateOfBirth: date('date_of_birth'),
  status: text('status').notNull().default('prospect'),
  emergencyContacts: jsonb('emergency_contacts').notNull().default([]), medicalNotes: text('medical_notes'),
  emailOptOut: boolean('email_opt_out').notNull().default(false), emailDeliverable: boolean('email_deliverable').notNull().default(true),
  checkinCodeVersion: integer('checkin_code_version').notNull().default(1),
  checkinCodeHash: text('checkin_code_hash'), anonymizedAt: instant('anonymized_at'),
}, (t) => [
  ...scoped('members', t), ref('members_household_fk', t.gymId, t.householdId, households),
  unique('members_gym_household_id_key').on(t.gymId, t.householdId, t.id),
  unique('members_gym_checkin_hash_key').on(t.gymId, t.checkinCodeHash),
  index('members_gym_status_idx').on(t.gymId, t.status),
  choice('members_status_check', t.status, ['prospect', 'trial', 'active', 'frozen', 'cancelled', 'visitor']),
  check('members_checkin_version_check', sql`${t.checkinCodeVersion} > 0`),
]).enableRLS();
export const householdUsers = pgTable('household_users', {
  ...base(), householdId: uuid('household_id').notNull(), userId: uuid('user_id').notNull().references(() => authUser.id),
  scope: text('scope').notNull(), memberId: uuid('member_id'),
}, (t) => [
  ...scoped('household_users', t), ref('household_users_household_fk', t.gymId, t.householdId, households),
  foreignKey({ name: 'household_users_member_fk', columns: [t.gymId, t.householdId, t.memberId], foreignColumns: [members.gymId, members.householdId, members.id] }),
  unique('household_users_gym_household_user_key').on(t.gymId, t.householdId, t.userId),
  choice('household_users_scope_check', t.scope, ['payer', 'member']),
  check('household_users_member_scope_check', sql`${t.scope} <> 'member' or ${t.memberId} is not null`),
]).enableRLS();
export const memberTags = pgTable('member_tags', {
  ...base(), name: text('name').notNull(), color: text('color'),
}, (t) => [...scoped('member_tags', t), unique('member_tags_gym_name_key').on(t.gymId, t.name)]).enableRLS();
export const memberTagLinks = pgTable('member_tag_links', {
  ...base(), memberId: uuid('member_id').notNull(), tagId: uuid('tag_id').notNull(),
}, (t) => [
  ...scoped('member_tag_links', t), ref('member_tag_links_member_fk', t.gymId, t.memberId, members),
  ref('member_tag_links_tag_fk', t.gymId, t.tagId, memberTags), unique('member_tag_links_pair_key').on(t.gymId, t.memberId, t.tagId),
]).enableRLS();
