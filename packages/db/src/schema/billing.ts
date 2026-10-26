// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { base, choice, currencyCheck, gymCurrency, instant, ref, revision, revisionCheck, scoped } from './common.js';
import { households, members } from './members.js';
/** rate_millionths is the rate in millionths of the taxable amount: 99_750 = 9.975%. */
export const taxRates = pgTable('tax_rates', {
  ...base(), name: text('name').notNull(), rateMillionths: integer('rate_millionths').notNull(),
  inclusive: boolean('inclusive').notNull().default(false), active: boolean('active').notNull().default(true), ...revision(),
}, (t) => [...scoped('tax_rates', t), check('tax_rates_rate_check', sql`${t.rateMillionths} between 0 and 1000000`),
  revisionCheck('tax_rates_revision_check', t.revision)]).enableRLS();
export const plans = pgTable('plans', {
  ...base(), name: text('name').notNull(), amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(), interval: text('interval').notNull(),
  signupFeeCents: integer('signup_fee_cents').notNull().default(0), trialDays: integer('trial_days').notNull().default(0),
  // Optional fixed term; a membership records its own commitment_ends_on when assigned.
  commitmentMonths: integer('commitment_months'), active: boolean('active').notNull().default(true), ...revision(),
}, (t) => [...scoped('plans', t), gymCurrency('plans_currency_fk', t),
  currencyCheck('plans_currency_check', t.currency), choice('plans_interval_check', t.interval, ['monthly', 'annual']),
  check('plans_amount_check', sql`${t.amountCents} >= 0 and ${t.signupFeeCents} >= 0 and ${t.trialDays} >= 0`),
  check('plans_commitment_check', sql`${t.commitmentMonths} is null or ${t.commitmentMonths} > 0`),
  revisionCheck('plans_revision_check', t.revision)]).enableRLS();
export const planTaxRates = pgTable('plan_tax_rates', {
  ...base(), planId: uuid('plan_id').notNull(), taxRateId: uuid('tax_rate_id').notNull(),
}, (t) => [...scoped('plan_tax_rates', t), ref('plan_tax_rates_plan_fk', t.gymId, t.planId, plans),
  ref('plan_tax_rates_tax_fk', t.gymId, t.taxRateId, taxRates),
  unique('plan_tax_rates_pair_key').on(t.gymId, t.planId, t.taxRateId)]).enableRLS();
export const chargeTypes = pgTable('charge_types', {
  ...base(), name: text('name').notNull(), amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(), active: boolean('active').notNull().default(true), ...revision(),
}, (t) => [...scoped('charge_types', t), gymCurrency('charge_types_currency_fk', t),
  currencyCheck('charge_types_currency_check', t.currency), check('charge_types_amount_check', sql`${t.amountCents} >= 0`),
  revisionCheck('charge_types_revision_check', t.revision)]).enableRLS();
export const chargeTypeTaxRates = pgTable('charge_type_tax_rates', {
  ...base(), chargeTypeId: uuid('charge_type_id').notNull(), taxRateId: uuid('tax_rate_id').notNull(),
}, (t) => [...scoped('charge_type_tax_rates', t), ref('charge_type_tax_rates_charge_type_fk', t.gymId, t.chargeTypeId, chargeTypes),
  ref('charge_type_tax_rates_tax_fk', t.gymId, t.taxRateId, taxRates),
  unique('charge_type_tax_rates_pair_key').on(t.gymId, t.chargeTypeId, t.taxRateId)]).enableRLS();
export const memberships = pgTable('memberships', {
  ...base(), householdId: uuid('household_id').notNull(), memberId: uuid('member_id').notNull(), planId: uuid('plan_id').notNull(),
  status: text('status').notNull().default('pending'), interval: text('interval').notNull(),
  amountCents: integer('amount_cents').notNull(), currency: text('currency').notNull(),
  nextDueOn: date('next_due_on').notNull(), startsOn: date('starts_on').notNull(), trialEndsOn: date('trial_ends_on'),
  // Original annual billing anniversary; retained when next_due_on advances or clamps in a short year.
  anniversaryOn: date('anniversary_on'),
  frozenAt: instant('frozen_at'), resumesOn: date('resumes_on'), cancelledAt: instant('cancelled_at'),
  // Recorded, never enforced; kept when the plan changes.
  commitmentEndsOn: date('commitment_ends_on'), ...revision(),
}, (t) => [...scoped('memberships', t), ref('memberships_household_fk', t.gymId, t.householdId, households),
  foreignKey({ name: 'memberships_member_fk', columns: [t.gymId, t.householdId, t.memberId], foreignColumns: [members.gymId, members.householdId, members.id] }),
  ref('memberships_plan_fk', t.gymId, t.planId, plans), gymCurrency('memberships_currency_fk', t),
  unique('memberships_gym_household_id_key').on(t.gymId, t.householdId, t.id),
  index('memberships_due_idx').on(t.gymId, t.status, t.nextDueOn),
  index('memberships_member_idx').on(t.gymId, t.memberId),
  choice('memberships_status_check', t.status, ['pending', 'trial', 'active', 'frozen', 'cancelled']),
  choice('memberships_interval_check', t.interval, ['monthly', 'annual']),
  currencyCheck('memberships_currency_check', t.currency), check('memberships_amount_check', sql`${t.amountCents} >= 0`),
  revisionCheck('memberships_revision_check', t.revision)]).enableRLS();
/** number is the per-gym display number, allocated by allocateInvoiceNumber when the invoice is issued; drafts have none. */
export const invoices = pgTable('invoices', {
  ...base(), householdId: uuid('household_id').notNull(), kind: text('kind').notNull(),
  status: text('status').notNull().default('draft'), number: integer('number'), dueOn: date('due_on').notNull(),
  periodStartsOn: date('period_starts_on'), periodEndsOn: date('period_ends_on'),
  amountCents: integer('amount_cents').notNull(), currency: text('currency').notNull(),
  paidAt: instant('paid_at'), checkoutSessionId: text('checkout_session_id'),
  checkoutExpiresAt: instant('checkout_expires_at'), needsReview: boolean('needs_review').notNull().default(false),
  disputeId: text('dispute_id'), disputeStatus: text('dispute_status'),
}, (t) => [...scoped('invoices', t), ref('invoices_household_fk', t.gymId, t.householdId, households),
  gymCurrency('invoices_currency_fk', t),
  unique('invoices_gym_household_id_key').on(t.gymId, t.householdId, t.id),
  unique('invoices_gym_household_id_currency_key').on(t.gymId, t.householdId, t.id, t.currency),
  unique('invoices_gym_id_currency_key').on(t.gymId, t.id, t.currency),
  unique('invoices_number_key').on(t.gymId, t.number),
  uniqueIndex('invoices_cycle_key').on(t.gymId, t.householdId, t.kind, t.dueOn).where(sql`${t.kind} = 'cycle'`),
  choice('invoices_kind_check', t.kind, ['cycle', 'one_off']),
  choice('invoices_status_check', t.status, ['draft', 'open', 'processing', 'past_due', 'paid', 'void', 'partially_refunded', 'refunded']),
  check('invoices_number_check', sql`(${t.status} = 'draft' and ${t.number} is null) or (${t.status} <> 'draft' and ${t.number} is not null and ${t.number} > 0)`),
  currencyCheck('invoices_currency_check', t.currency), check('invoices_amount_check', sql`${t.amountCents} >= 0`),
  check('invoices_period_check', sql`${t.kind} <> 'cycle' or (${t.periodStartsOn} is not null and ${t.periodEndsOn} is not null and ${t.periodEndsOn} > ${t.periodStartsOn})`),
]).enableRLS();
/** One row per gym; allocation upserts and increments it, so concurrent issuers serialize on the row lock. */
export const invoiceSequences = pgTable('invoice_sequences', {
  ...base(), lastNumber: integer('last_number').notNull().default(0),
}, (t) => [...scoped('invoice_sequences', t), unique('invoice_sequences_gym_key').on(t.gymId),
  check('invoice_sequences_number_check', sql`${t.lastNumber} >= 0`)]).enableRLS();
/** Tax lines snapshot the rate and treatment applied at issue; description holds the tax name, so later rate edits never rewrite receipts. */
export const invoiceLineItems = pgTable('invoice_line_items', {
  ...base(), householdId: uuid('household_id').notNull(), invoiceId: uuid('invoice_id').notNull(),
  membershipId: uuid('membership_id'), chargeTypeId: uuid('charge_type_id'), taxRateId: uuid('tax_rate_id'),
  kind: text('kind').notNull(), description: text('description').notNull(),
  amountCents: integer('amount_cents').notNull(), currency: text('currency').notNull(), quantity: integer('quantity').notNull().default(1),
  taxRateMillionths: integer('tax_rate_millionths'), taxInclusive: boolean('tax_inclusive'),
}, (t) => [...scoped('invoice_line_items', t),
  foreignKey({ name: 'invoice_line_items_invoice_fk', columns: [t.gymId, t.householdId, t.invoiceId, t.currency],
    foreignColumns: [invoices.gymId, invoices.householdId, invoices.id, invoices.currency] }),
  foreignKey({ name: 'invoice_line_items_membership_fk', columns: [t.gymId, t.householdId, t.membershipId], foreignColumns: [memberships.gymId, memberships.householdId, memberships.id] }),
  ref('invoice_line_items_charge_type_fk', t.gymId, t.chargeTypeId, chargeTypes), ref('invoice_line_items_tax_fk', t.gymId, t.taxRateId, taxRates),
  index('invoice_line_items_invoice_idx').on(t.gymId, t.invoiceId),
  choice('invoice_line_items_kind_check', t.kind, ['membership', 'signup_fee', 'charge', 'discount', 'tax']),
  check('invoice_line_items_tax_check', sql`(${t.kind} = 'tax' and ${t.taxRateMillionths} is not null and ${t.taxRateMillionths} between 0 and 1000000 and ${t.taxInclusive} is not null)
    or (${t.kind} <> 'tax' and ${t.taxRateMillionths} is null and ${t.taxInclusive} is null and ${t.taxRateId} is null)`),
  currencyCheck('invoice_line_items_currency_check', t.currency), check('invoice_line_items_quantity_check', sql`${t.quantity} > 0`),
]).enableRLS();
/** is_default marks the card the charge runner uses; the row itself belongs to the household, so the default always does. */
export const paymentMethods = pgTable('payment_methods', {
  ...base(), householdId: uuid('household_id').notNull(), processorId: text('processor_id').notNull(),
  brand: text('brand'), last4: text('last4'), expiryMonth: integer('expiry_month'), expiryYear: integer('expiry_year'),
  isDefault: boolean('is_default').notNull().default(false), revokedAt: instant('revoked_at'),
  processorCreatedAt: instant('processor_created_at'),
}, (t) => [...scoped('payment_methods', t), ref('payment_methods_household_fk', t.gymId, t.householdId, households),
  unique('payment_methods_processor_key').on(t.gymId, t.processorId),
  unique('payment_methods_gym_household_id_key').on(t.gymId, t.householdId, t.id),
  uniqueIndex('payment_methods_default_key').on(t.gymId, t.householdId).where(sql`${t.isDefault}`),
  check('payment_methods_default_check', sql`not ${t.isDefault} or ${t.revokedAt} is null`),
  check('payment_methods_last4_check', sql`${t.last4} ~ '^[0-9]{4}$'`),
  check('payment_methods_expiry_check', sql`${t.expiryMonth} between 1 and 12 and ${t.expiryYear} >= 2000`)]).enableRLS();
export const paymentAttempts = pgTable('payment_attempts', {
  ...base(), invoiceId: uuid('invoice_id').notNull(), attemptNumber: integer('attempt_number').notNull(),
  amountCents: integer('amount_cents').notNull(), currency: text('currency').notNull(),
  savedPaymentMethod: text('saved_payment_method').notNull(), stripeCustomerId: text('stripe_customer_id').notNull(),
  paymentIntentId: text('payment_intent_id'), status: text('status').notNull().default('pending'),
  declineCode: text('decline_code'), error: text('error'), resolvedAt: instant('resolved_at'),
}, (t) => [...scoped('payment_attempts', t),
  foreignKey({ name: 'payment_attempts_invoice_fk', columns: [t.gymId, t.invoiceId, t.currency], foreignColumns: [invoices.gymId, invoices.id, invoices.currency] }),
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
}, (t) => [...scoped('payments', t),
  foreignKey({ name: 'payments_invoice_fk', columns: [t.gymId, t.invoiceId, t.currency], foreignColumns: [invoices.gymId, invoices.id, invoices.currency] }),
  unique('payments_gym_id_currency_key').on(t.gymId, t.id, t.currency),
  unique('payments_intent_key').on(t.gymId, t.paymentIntentId),
  unique('payments_charge_key').on(t.gymId, t.chargeId),
  index('payments_invoice_idx').on(t.gymId, t.invoiceId),
  choice('payments_method_check', t.method, ['card', 'cash', 'check', 'other']),
  currencyCheck('payments_currency_check', t.currency), check('payments_amount_check', sql`${t.amountCents} > 0`)]).enableRLS();
export const refunds = pgTable('refunds', {
  ...base(), paymentId: uuid('payment_id').notNull(), amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(), processorId: text('processor_id'), status: text('status').notNull().default('pending'),
  reason: text('reason'), resolvedAt: instant('resolved_at'),
}, (t) => [...scoped('refunds', t),
  foreignKey({ name: 'refunds_payment_fk', columns: [t.gymId, t.paymentId, t.currency], foreignColumns: [payments.gymId, payments.id, payments.currency] }),
  unique('refunds_processor_key').on(t.gymId, t.processorId),
  index('refunds_payment_idx').on(t.gymId, t.paymentId),
  choice('refunds_status_check', t.status, ['pending', 'succeeded', 'failed']),
  currencyCheck('refunds_currency_check', t.currency), check('refunds_amount_check', sql`${t.amountCents} > 0`)]).enableRLS();
