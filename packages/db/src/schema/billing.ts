// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { AppliedMembershipDiscount } from '@plaingym/shared/contracts';
import { base, choice, currencyCheck, gymCurrency, instant, ref, revision, revisionCheck, scoped } from './common.js';
import { households, members } from './members.js';
import { authUser } from './auth.js';
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
  commitmentEndsOn: date('commitment_ends_on'),
  // A scheduled plan switch: all four set or all null. The amount and interval are quoted when the
  // switch is scheduled, so a later price change on the plan doesn't alter it.
  scheduledPlanId: uuid('scheduled_plan_id'), scheduledAmountCents: integer('scheduled_amount_cents'),
  scheduledInterval: text('scheduled_interval'), scheduledOn: date('scheduled_on'),
  // Where the scheduled change came from: a plan switch (`switch`), the price a downgrade now keeps until the next
  // due date (`downgrade`) or a plan price change (`price_change`). Null on changes scheduled before the column,
  // which follow the switch rules; read only while a change is scheduled.
  scheduledOrigin: text('scheduled_origin'),
  // The reason given for the latest commitment override; member erasure clears it.
  switchOverrideReason: text('switch_override_reason'), ...revision(),
}, (t) => [...scoped('memberships', t), ref('memberships_household_fk', t.gymId, t.householdId, households),
  foreignKey({ name: 'memberships_member_fk', columns: [t.gymId, t.householdId, t.memberId], foreignColumns: [members.gymId, members.householdId, members.id] }),
  ref('memberships_plan_fk', t.gymId, t.planId, plans), ref('memberships_scheduled_plan_fk', t.gymId, t.scheduledPlanId, plans),
  gymCurrency('memberships_currency_fk', t),
  unique('memberships_gym_household_id_key').on(t.gymId, t.householdId, t.id),
  index('memberships_due_idx').on(t.gymId, t.status, t.nextDueOn),
  index('memberships_member_idx').on(t.gymId, t.memberId),
  choice('memberships_status_check', t.status, ['pending', 'trial', 'active', 'frozen', 'cancelled']),
  choice('memberships_interval_check', t.interval, ['monthly', 'annual']),
  currencyCheck('memberships_currency_check', t.currency), check('memberships_amount_check', sql`${t.amountCents} >= 0`),
  check('memberships_scheduled_check', sql`(${t.scheduledPlanId} is null and ${t.scheduledAmountCents} is null and ${t.scheduledInterval} is null and ${t.scheduledOn} is null)
    or (${t.scheduledPlanId} is not null and ${t.scheduledAmountCents} is not null and ${t.scheduledAmountCents} >= 0
      and ${t.scheduledInterval} in ('monthly', 'annual') and ${t.scheduledOn} is not null)`),
  choice('memberships_scheduled_origin_check', t.scheduledOrigin, ['switch', 'downgrade', 'price_change']),
  check('memberships_switch_override_reason_check', sql`${t.switchOverrideReason} is null or char_length(${t.switchOverrideReason}) between 1 and 500`),
  revisionCheck('memberships_revision_check', t.revision)]).enableRLS();

/** Named catalog terms; application history keeps its own snapshot. */
export const discounts = pgTable('discounts', {
  ...base(), name: text('name').notNull(), code: text('code'),
  percentBasisPoints: integer('percent_basis_points'), amountCents: integer('amount_cents'), currency: text('currency').notNull(),
  waivesSignupFee: boolean('waives_signup_fee').notNull().default(false), duration: text('duration'), cycles: integer('cycles'),
  endsOn: date('ends_on'), maxUses: integer('max_uses'), uses: integer('uses').notNull().default(0),
  active: boolean('active').notNull().default(true), ...revision(),
}, (t) => [...scoped('discounts', t), gymCurrency('discounts_currency_fk', t),
  uniqueIndex('discounts_name_key').on(t.gymId, sql`lower(${t.name})`),
  uniqueIndex('discounts_code_key').on(t.gymId, sql`lower(${t.code})`).where(sql`${t.code} is not null`),
  check('discounts_name_check', sql`char_length(btrim(${t.name})) between 1 and 100 and ${t.name} = btrim(${t.name})`),
  check('discounts_code_check', sql`${t.code} is null or ${t.code} ~ '^[A-Za-z0-9-]{3,40}$'`),
  currencyCheck('discounts_currency_check', t.currency),
  check('discounts_price_check', sql`(${t.percentBasisPoints} is null or ${t.percentBasisPoints} between 1 and 10000)
    and (${t.amountCents} is null or ${t.amountCents} > 0)
    and (${t.percentBasisPoints} is null or ${t.amountCents} is null)
    and (${t.percentBasisPoints} is not null or ${t.amountCents} is not null or ${t.waivesSignupFee})`),
  check('discounts_duration_check', sql`(${t.percentBasisPoints} is null and ${t.amountCents} is null and ${t.duration} is null and ${t.cycles} is null)
    or ((${t.percentBasisPoints} is not null or ${t.amountCents} is not null) and ${t.duration} is not null
      and ((${t.duration} in ('once', 'forever') and ${t.cycles} is null)
        or (${t.duration} = 'cycles' and ${t.cycles} is not null and ${t.cycles} >= 1)))`),
  check('discounts_uses_check', sql`${t.uses} >= 0 and (${t.maxUses} is null or (${t.maxUses} > 0 and ${t.uses} <= ${t.maxUses}))`),
  revisionCheck('discounts_revision_check', t.revision),
]).enableRLS();

export const discountPlans = pgTable('discount_plans', {
  ...base(), discountId: uuid('discount_id').notNull(), planId: uuid('plan_id').notNull(),
}, (t) => [...scoped('discount_plans', t), ref('discount_plans_discount_fk', t.gymId, t.discountId, discounts),
  ref('discount_plans_plan_fk', t.gymId, t.planId, plans),
  unique('discount_plans_pair_key').on(t.gymId, t.discountId, t.planId),
  index('discount_plans_plan_idx').on(t.gymId, t.planId),
]).enableRLS();

/** Snapshot of the terms at application time, including the then-eligible plan list (empty means all). */
export const membershipDiscounts = pgTable('membership_discounts', {
  ...base(), householdId: uuid('household_id').notNull(), membershipId: uuid('membership_id').notNull(),
  discountId: uuid('discount_id').notNull(), name: text('name').notNull(), percentBasisPoints: integer('percent_basis_points'),
  amountCents: integer('amount_cents'), currency: text('currency').notNull(), waivesSignupFee: boolean('waives_signup_fee').notNull(),
  duration: text('duration'), cyclesLeft: integer('cycles_left'), planIds: uuid('plan_ids').array().notNull().default(sql`'{}'::uuid[]`),
  appliedAt: instant('applied_at').notNull(), endedAt: instant('ended_at'), endReason: text('end_reason'), ...revision(),
}, (t) => [...scoped('membership_discounts', t),
  foreignKey({ name: 'membership_discounts_membership_fk', columns: [t.gymId, t.householdId, t.membershipId],
    foreignColumns: [memberships.gymId, memberships.householdId, memberships.id] }),
  ref('membership_discounts_discount_fk', t.gymId, t.discountId, discounts),
  gymCurrency('membership_discounts_currency_fk', t),
  uniqueIndex('membership_discounts_live_key').on(t.gymId, t.membershipId).where(sql`${t.endedAt} is null`),
  index('membership_discounts_discount_idx').on(t.gymId, t.discountId),
  check('membership_discounts_name_check', sql`char_length(btrim(${t.name})) between 1 and 100`),
  currencyCheck('membership_discounts_currency_check', t.currency),
  check('membership_discounts_price_check', sql`(${t.percentBasisPoints} is null or ${t.percentBasisPoints} between 1 and 10000)
    and (${t.amountCents} is null or ${t.amountCents} > 0)
    and (${t.percentBasisPoints} is null or ${t.amountCents} is null)
    and (${t.percentBasisPoints} is not null or ${t.amountCents} is not null or ${t.waivesSignupFee})`),
  check('membership_discounts_duration_check', sql`(${t.percentBasisPoints} is null and ${t.amountCents} is null and ${t.duration} is null and ${t.cyclesLeft} is null)
    or ((${t.percentBasisPoints} is not null or ${t.amountCents} is not null) and ${t.duration} is not null
      and ((${t.duration} = 'forever' and ${t.cyclesLeft} is null)
        or (${t.duration} in ('once', 'cycles') and ${t.cyclesLeft} is not null and ${t.cyclesLeft} >= 0
          and (${t.duration} <> 'once' or ${t.cyclesLeft} <= 1))))`),
  check('membership_discounts_end_check', sql`(${t.endedAt} is null and ${t.endReason} is null)
    or (${t.endedAt} is not null and ${t.endedAt} >= ${t.appliedAt} and ${t.endReason} is not null
      and ${t.endReason} in ('replaced', 'removed', 'switch', 'completed', 'released'))`),
  check('membership_discounts_plans_check', sql`array_position(${t.planIds}, null) is null`),
  revisionCheck('membership_discounts_revision_check', t.revision),
]).enableRLS();
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
  // The plan a membership or signup-fee line was billed under, recorded when the line is written; null on
  // other kinds and on lines written before it was recorded.
  planId: uuid('plan_id'),
  // Full-period terms, independent of proration, tax and later edits; null price means unknown historical terms.
  billedUnitAmountCents: integer('billed_unit_amount_cents'),
  billedDiscount: jsonb('billed_discount').$type<AppliedMembershipDiscount>(),
}, (t) => [...scoped('invoice_line_items', t),
  foreignKey({ name: 'invoice_line_items_invoice_fk', columns: [t.gymId, t.householdId, t.invoiceId, t.currency],
    foreignColumns: [invoices.gymId, invoices.householdId, invoices.id, invoices.currency] }),
  foreignKey({ name: 'invoice_line_items_membership_fk', columns: [t.gymId, t.householdId, t.membershipId], foreignColumns: [memberships.gymId, memberships.householdId, memberships.id] }),
  ref('invoice_line_items_charge_type_fk', t.gymId, t.chargeTypeId, chargeTypes), ref('invoice_line_items_tax_fk', t.gymId, t.taxRateId, taxRates),
  ref('invoice_line_items_plan_fk', t.gymId, t.planId, plans),
  check('invoice_line_items_plan_check', sql`${t.planId} is null or ${t.kind} in ('membership', 'signup_fee')`),
  check('invoice_line_items_billed_terms_check', sql`(${t.billedUnitAmountCents} is null and ${t.billedDiscount} is null)
    or (${t.kind} = 'membership' and ${t.billedUnitAmountCents} is not null and ${t.billedUnitAmountCents} >= 0
      and (${t.billedDiscount} is null or jsonb_typeof(${t.billedDiscount}) = 'object'))`),
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
  index('payments_gym_paid_at_idx').on(t.gymId, t.paidAt),
  choice('payments_method_check', t.method, ['card', 'cash', 'check', 'other']),
  currencyCheck('payments_currency_check', t.currency), check('payments_amount_check', sql`${t.amountCents} > 0`)]).enableRLS();
export const refunds = pgTable('refunds', {
  ...base(), paymentId: uuid('payment_id').notNull(), amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(), processorId: text('processor_id'), status: text('status').notNull().default('pending'),
  reason: text('reason'), resolvedAt: instant('resolved_at'),
  /** Set when the app created this reservation to send its row ID on the processor refund; null on rows from before the column. */
  taggedAt: instant('tagged_at'),
}, (t) => [...scoped('refunds', t),
  foreignKey({ name: 'refunds_payment_fk', columns: [t.gymId, t.paymentId, t.currency], foreignColumns: [payments.gymId, payments.id, payments.currency] }),
  unique('refunds_processor_key').on(t.gymId, t.processorId),
  index('refunds_payment_idx').on(t.gymId, t.paymentId),
  index('refunds_gym_resolved_at_idx').on(t.gymId, t.resolvedAt),
  choice('refunds_status_check', t.status, ['pending', 'succeeded', 'failed', 'canceled']),
  currencyCheck('refunds_currency_check', t.currency), check('refunds_amount_check', sql`${t.amountCents} > 0`)]).enableRLS();

export const classPacks = pgTable('class_packs', {
  ...base(), name: text('name').notNull(), amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(), credits: integer('credits').notNull(), expiryDays: integer('expiry_days'),
  active: boolean('active').notNull().default(true), ...revision(),
}, (t) => [...scoped('class_packs', t), gymCurrency('class_packs_currency_fk', t),
  currencyCheck('class_packs_currency_check', t.currency), check('class_packs_amount_check', sql`${t.amountCents} >= 0`),
  check('class_packs_credits_check', sql`${t.credits} between 1 and 100`),
  check('class_packs_expiry_check', sql`${t.expiryDays} is null or ${t.expiryDays} between 1 and 3650`),
  revisionCheck('class_packs_revision_check', t.revision)]).enableRLS();
export const classPackTaxRates = pgTable('class_pack_tax_rates', {
  ...base(), packId: uuid('pack_id').notNull(), taxRateId: uuid('tax_rate_id').notNull(),
}, (t) => [...scoped('class_pack_tax_rates', t), ref('class_pack_tax_rates_pack_fk', t.gymId, t.packId, classPacks),
  ref('class_pack_tax_rates_tax_fk', t.gymId, t.taxRateId, taxRates),
  unique('class_pack_tax_rates_pair_key').on(t.gymId, t.packId, t.taxRateId)]).enableRLS();
/** The invoice keeps its original payer; credits follow the member through household moves. */
export const classPackSales = pgTable('class_pack_sales', {
  ...base(), invoiceId: uuid('invoice_id').notNull(), householdId: uuid('household_id').notNull(),
  memberId: uuid('member_id').notNull(), packId: uuid('pack_id').notNull(),
  credits: integer('credits').notNull(), expiryDays: integer('expiry_days'),
}, (t) => [...scoped('class_pack_sales', t),
  foreignKey({ name: 'class_pack_sales_invoice_fk', columns: [t.gymId, t.householdId, t.invoiceId],
    foreignColumns: [invoices.gymId, invoices.householdId, invoices.id] }),
  ref('class_pack_sales_household_fk', t.gymId, t.householdId, households),
  ref('class_pack_sales_member_fk', t.gymId, t.memberId, members), ref('class_pack_sales_pack_fk', t.gymId, t.packId, classPacks),
  unique('class_pack_sales_invoice_key').on(t.gymId, t.invoiceId),
  unique('class_pack_sales_member_id_key').on(t.gymId, t.memberId, t.id),
  check('class_pack_sales_credits_check', sql`${t.credits} between 1 and 100`),
  check('class_pack_sales_expiry_check', sql`${t.expiryDays} is null or ${t.expiryDays} between 1 and 3650`),
]).enableRLS();
/** Only reason may be redacted; grants and spends are never edited or deleted by app. */
export const classCreditEntries = pgTable('class_credit_entries', {
  ...base(), memberId: uuid('member_id').notNull(), kind: text('kind').notNull(), credits: integer('credits').notNull(),
  lotId: uuid('lot_id'), saleId: uuid('sale_id'),
  // Undo deletes attendance, but its ID must remain available for idempotency.
  attendanceId: uuid('attendance_id'), expiresAt: instant('expires_at'), reason: text('reason'),
  adjustmentId: uuid('adjustment_id'), createdBy: uuid('created_by').references(() => authUser.id),
}, (t) => [...scoped('class_credit_entries', t), ref('class_credit_entries_member_fk', t.gymId, t.memberId, members),
  unique('class_credit_entries_member_id_key').on(t.gymId, t.memberId, t.id),
  foreignKey({ name: 'class_credit_entries_lot_fk', columns: [t.gymId, t.memberId, t.lotId],
    foreignColumns: [t.gymId, t.memberId, t.id] }),
  foreignKey({ name: 'class_credit_entries_sale_fk', columns: [t.gymId, t.memberId, t.saleId],
    foreignColumns: [classPackSales.gymId, classPackSales.memberId, classPackSales.id] }),
  choice('class_credit_entries_kind_check', t.kind, ['grant', 'use', 'expire', 'reverse', 'adjust']),
  check('class_credit_entries_sign_check', sql`${t.credits} <> 0 and
    (${t.kind} <> 'grant' or ${t.credits} > 0) and (${t.kind} <> 'use' or ${t.credits} = -1) and
    (${t.kind} <> 'expire' or ${t.credits} < 0) and
    (${t.kind} <> 'reverse' or (${t.saleId} is not null and ${t.credits} < 0) or (${t.attendanceId} is not null and ${t.credits} = 1))`),
  check('class_credit_entries_lot_check', sql`(${t.lotId} is null) = (${t.kind} = 'grant' or (${t.kind} = 'adjust' and ${t.credits} > 0))`),
  check('class_credit_entries_expiry_check', sql`${t.expiresAt} is null or ${t.lotId} is null`),
  check('class_credit_entries_source_check', sql`
    (${t.kind} = 'grant' and ${t.saleId} is not null and ${t.attendanceId} is null) or
    (${t.kind} = 'use' and ${t.attendanceId} is not null and ${t.saleId} is null) or
    (${t.kind} = 'reverse' and ((${t.saleId} is not null) <> (${t.attendanceId} is not null))) or
    (${t.kind} in ('expire', 'adjust') and ${t.saleId} is null and ${t.attendanceId} is null)`),
  check('class_credit_entries_adjustment_check', sql`
    (${t.kind} = 'adjust' and ${t.adjustmentId} is not null and ${t.reason} is not null and char_length(${t.reason}) <= 500) or
    (${t.kind} <> 'adjust' and ${t.adjustmentId} is null and ${t.reason} is null)`),
  uniqueIndex('class_credit_entries_grant_sale_key').on(t.gymId, t.saleId).where(sql`${t.kind} = 'grant'`),
  uniqueIndex('class_credit_entries_reverse_sale_key').on(t.gymId, t.saleId).where(sql`${t.kind} = 'reverse' and ${t.saleId} is not null`),
  uniqueIndex('class_credit_entries_use_attendance_key').on(t.gymId, t.attendanceId).where(sql`${t.kind} = 'use'`),
  uniqueIndex('class_credit_entries_reverse_attendance_key').on(t.gymId, t.attendanceId).where(sql`${t.kind} = 'reverse' and ${t.attendanceId} is not null`),
  uniqueIndex('class_credit_entries_expire_lot_key').on(t.gymId, t.lotId).where(sql`${t.kind} = 'expire'`),
  uniqueIndex('class_credit_entries_adjust_lot_key').on(t.gymId, t.adjustmentId, t.lotId).where(sql`${t.kind} = 'adjust' and ${t.lotId} is not null`),
  uniqueIndex('class_credit_entries_adjust_open_key').on(t.gymId, t.adjustmentId).where(sql`${t.kind} = 'adjust' and ${t.lotId} is null`),
  index('class_credit_entries_member_idx').on(t.gymId, t.memberId, t.createdAt),
  index('class_credit_entries_expiry_idx').on(t.gymId, t.expiresAt).where(sql`${t.lotId} is null`),
]).enableRLS();
