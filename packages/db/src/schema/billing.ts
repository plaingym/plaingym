// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, integer, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { base, choice, currencyCheck, instant, ref, scoped } from './common.js';
import { households, members } from './members.js';
export const taxRates = pgTable('tax_rates', {
  ...base(), name: text('name').notNull(), basisPoints: integer('basis_points').notNull(),
  inclusive: boolean('inclusive').notNull().default(false), active: boolean('active').notNull().default(true),
}, (t) => [...scoped('tax_rates', t), check('tax_rates_percentage_check', sql`${t.basisPoints} between 0 and 10000`)]).enableRLS();
export const plans = pgTable('plans', {
  ...base(), name: text('name').notNull(), amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(), interval: text('interval').notNull(),
  signupFeeCents: integer('signup_fee_cents').notNull().default(0), trialDays: integer('trial_days').notNull().default(0),
  taxRateId: uuid('tax_rate_id'), active: boolean('active').notNull().default(true),
}, (t) => [...scoped('plans', t), ref('plans_tax_fk', t.gymId, t.taxRateId, taxRates),
  currencyCheck('plans_currency_check', t.currency), choice('plans_interval_check', t.interval, ['monthly', 'annual']),
  check('plans_amount_check', sql`${t.amountCents} >= 0 and ${t.signupFeeCents} >= 0 and ${t.trialDays} >= 0`)]).enableRLS();
export const chargeTypes = pgTable('charge_types', {
  ...base(), name: text('name').notNull(), amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(), taxRateId: uuid('tax_rate_id'), active: boolean('active').notNull().default(true),
}, (t) => [...scoped('charge_types', t), ref('charge_types_tax_fk', t.gymId, t.taxRateId, taxRates),
  currencyCheck('charge_types_currency_check', t.currency), check('charge_types_amount_check', sql`${t.amountCents} >= 0`)]).enableRLS();
export const memberships = pgTable('memberships', {
  ...base(), householdId: uuid('household_id').notNull(), memberId: uuid('member_id').notNull(), planId: uuid('plan_id').notNull(),
  status: text('status').notNull().default('pending'), interval: text('interval').notNull(),
  amountCents: integer('amount_cents').notNull(), currency: text('currency').notNull(),
  nextDueOn: date('next_due_on').notNull(), startsOn: date('starts_on').notNull(), trialEndsOn: date('trial_ends_on'),
  frozenAt: instant('frozen_at'), resumesOn: date('resumes_on'), cancelledAt: instant('cancelled_at'),
  commitmentEndsAt: instant('commitment_ends_at'),
}, (t) => [...scoped('memberships', t), ref('memberships_household_fk', t.gymId, t.householdId, households),
  foreignKey({ name: 'memberships_member_fk', columns: [t.gymId, t.householdId, t.memberId], foreignColumns: [members.gymId, members.householdId, members.id] }),
  ref('memberships_plan_fk', t.gymId, t.planId, plans),
  unique('memberships_gym_household_id_key').on(t.gymId, t.householdId, t.id),
  choice('memberships_status_check', t.status, ['pending', 'trial', 'active', 'frozen', 'cancelled']),
  choice('memberships_interval_check', t.interval, ['monthly', 'annual']),
  currencyCheck('memberships_currency_check', t.currency), check('memberships_amount_check', sql`${t.amountCents} >= 0`)]).enableRLS();
export const invoices = pgTable('invoices', {
  ...base(), householdId: uuid('household_id').notNull(), kind: text('kind').notNull(),
  status: text('status').notNull().default('draft'), dueOn: date('due_on').notNull(),
  periodStartsOn: date('period_starts_on'), periodEndsOn: date('period_ends_on'),
  amountCents: integer('amount_cents').notNull(), currency: text('currency').notNull(),
  paidAt: instant('paid_at'), checkoutSessionId: text('checkout_session_id'),
  checkoutExpiresAt: instant('checkout_expires_at'), needsReview: boolean('needs_review').notNull().default(false),
  disputeId: text('dispute_id'), disputeStatus: text('dispute_status'),
}, (t) => [...scoped('invoices', t), ref('invoices_household_fk', t.gymId, t.householdId, households),
  unique('invoices_gym_household_id_key').on(t.gymId, t.householdId, t.id),
  uniqueIndex('invoices_cycle_key').on(t.gymId, t.householdId, t.kind, t.dueOn).where(sql`${t.kind} = 'cycle'`),
  choice('invoices_kind_check', t.kind, ['cycle', 'one_off']),
  choice('invoices_status_check', t.status, ['draft', 'open', 'processing', 'past_due', 'paid', 'void', 'partially_refunded', 'refunded']),
  currencyCheck('invoices_currency_check', t.currency), check('invoices_amount_check', sql`${t.amountCents} >= 0`),
  check('invoices_period_check', sql`${t.kind} <> 'cycle' or (${t.periodStartsOn} is not null and ${t.periodEndsOn} is not null and ${t.periodEndsOn} > ${t.periodStartsOn})`),
]).enableRLS();
export const invoiceLineItems = pgTable('invoice_line_items', {
  ...base(), householdId: uuid('household_id').notNull(), invoiceId: uuid('invoice_id').notNull(),
  membershipId: uuid('membership_id'), chargeTypeId: uuid('charge_type_id'), taxRateId: uuid('tax_rate_id'),
  kind: text('kind').notNull(), description: text('description').notNull(),
  amountCents: integer('amount_cents').notNull(), currency: text('currency').notNull(), quantity: integer('quantity').notNull().default(1),
}, (t) => [...scoped('invoice_line_items', t),
  foreignKey({ name: 'invoice_line_items_invoice_fk', columns: [t.gymId, t.householdId, t.invoiceId], foreignColumns: [invoices.gymId, invoices.householdId, invoices.id] }),
  foreignKey({ name: 'invoice_line_items_membership_fk', columns: [t.gymId, t.householdId, t.membershipId], foreignColumns: [memberships.gymId, memberships.householdId, memberships.id] }),
  ref('invoice_line_items_charge_type_fk', t.gymId, t.chargeTypeId, chargeTypes), ref('invoice_line_items_tax_fk', t.gymId, t.taxRateId, taxRates),
  choice('invoice_line_items_kind_check', t.kind, ['membership', 'signup_fee', 'charge', 'discount', 'tax']),
  currencyCheck('invoice_line_items_currency_check', t.currency), check('invoice_line_items_quantity_check', sql`${t.quantity} > 0`),
]).enableRLS();
export const paymentMethods = pgTable('payment_methods', {
  ...base(), householdId: uuid('household_id').notNull(), processorId: text('processor_id').notNull(),
  brand: text('brand'), last4: text('last4'), expiryMonth: integer('expiry_month'), expiryYear: integer('expiry_year'),
  revokedAt: instant('revoked_at'),
}, (t) => [...scoped('payment_methods', t), ref('payment_methods_household_fk', t.gymId, t.householdId, households),
  unique('payment_methods_processor_key').on(t.gymId, t.processorId),
  unique('payment_methods_gym_household_id_key').on(t.gymId, t.householdId, t.id),
  check('payment_methods_last4_check', sql`${t.last4} ~ '^[0-9]{4}$'`),
  check('payment_methods_expiry_check', sql`${t.expiryMonth} between 1 and 12 and ${t.expiryYear} >= 2000`)]).enableRLS();
export const paymentAttempts = pgTable('payment_attempts', {
  ...base(), invoiceId: uuid('invoice_id').notNull(), attemptNumber: integer('attempt_number').notNull(),
  amountCents: integer('amount_cents').notNull(), currency: text('currency').notNull(),
  savedPaymentMethod: text('saved_payment_method').notNull(), stripeCustomerId: text('stripe_customer_id').notNull(),
  paymentIntentId: text('payment_intent_id'), status: text('status').notNull().default('pending'),
  declineCode: text('decline_code'), error: text('error'), resolvedAt: instant('resolved_at'),
}, (t) => [...scoped('payment_attempts', t), ref('payment_attempts_invoice_fk', t.gymId, t.invoiceId, invoices),
  unique('payment_attempts_number_key').on(t.gymId, t.invoiceId, t.attemptNumber),
  unique('payment_attempts_intent_key').on(t.gymId, t.paymentIntentId),
  uniqueIndex('payment_attempts_pending_key').on(t.gymId, t.invoiceId).where(sql`${t.status} = 'pending'`),
  choice('payment_attempts_status_check', t.status, ['pending', 'succeeded', 'failed', 'requires_action']),
  currencyCheck('payment_attempts_currency_check', t.currency),
  check('payment_attempts_amount_check', sql`${t.amountCents} >= 0 and ${t.attemptNumber} > 0`),
]).enableRLS();
export const payments = pgTable('payments', {
  ...base(), invoiceId: uuid('invoice_id').notNull(), method: text('method').notNull(),
  amountCents: integer('amount_cents').notNull(), currency: text('currency').notNull(),
  paymentIntentId: text('payment_intent_id'), chargeId: text('charge_id'), reference: text('reference'),
  paidAt: instant('paid_at').notNull(),
}, (t) => [...scoped('payments', t), ref('payments_invoice_fk', t.gymId, t.invoiceId, invoices),
  unique('payments_intent_key').on(t.gymId, t.paymentIntentId),
  unique('payments_charge_key').on(t.gymId, t.chargeId),
  choice('payments_method_check', t.method, ['card', 'cash', 'check', 'other']),
  currencyCheck('payments_currency_check', t.currency), check('payments_amount_check', sql`${t.amountCents} > 0`)]).enableRLS();
export const refunds = pgTable('refunds', {
  ...base(), paymentId: uuid('payment_id').notNull(), amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(), processorId: text('processor_id'), status: text('status').notNull().default('pending'),
  reason: text('reason'), resolvedAt: instant('resolved_at'),
}, (t) => [...scoped('refunds', t), ref('refunds_payment_fk', t.gymId, t.paymentId, payments),
  unique('refunds_processor_key').on(t.gymId, t.processorId),
  choice('refunds_status_check', t.status, ['pending', 'succeeded', 'failed']),
  currencyCheck('refunds_currency_check', t.currency), check('refunds_amount_check', sql`${t.amountCents} > 0`)]).enableRLS();
