// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { forGym, auditEvents, households, householdUsers, invoices, members, memberships, plans, planTaxRates, signedLinks,
  paymentMethods, staffRoles, taxRates, uuidv7, writeAudit, revisionGuard, assertRevised, membershipDiscounts, invoiceLineItems,
  type Transaction } from '@plaingym/db';
import { AppError, createTranslator, type Clock } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import * as c from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import { z } from 'zod';
import { clock as defaultClock } from '../../core/clock.js';
import { logError } from '../../core/log.js';
import { createGymSettingsAccessor, readGymSettings } from '../../areas/settings/settings.js';
import { addsTaxOnTop } from '../../areas/billing/invoicing/adds-tax-on-top.js';
import { signedLinkWaiversComplete, type WaiversService } from '../../areas/waivers/waivers.js';
import { needsGuardian, validateSignatureImage } from '../../areas/waivers/snapshot.js';
import { createMembershipService } from '../../areas/billing/memberships.js';
import { recordLeadIntake } from '../../areas/leads/intake.js';
import { calculateCycleInvoice, calculateOneOffInvoice } from '../../areas/billing/invoicing/index.js';
import { issue, system } from '../../areas/billing/runner/store.js';
import type { CheckoutReturn, createSignedLinkCheckout } from '../../areas/billing/signed-link-checkout.js';
import { cardChargeIssue } from '@plaingym/shared/money';
import { createSignedLinksService } from '../../areas/links/service.js';
import { assertPortalLoginTarget, requestPortalConfirmation } from '../../areas/members/household-users.js';
import type { PortalInvitationService } from '../../areas/members/household-users.invitations.js';
import type { AccountService } from '../../infra/auth/accounts.js';
import { createPortalInvitationStore } from '../../infra/auth/portal-invitations.js';
import type { Uploads } from '../../infra/storage/index.js';
import type { Payments } from '../../infra/payments/index.js';
import { createJoinCleanup } from './join.cleanup.js';
import { createInvoiceTransitions } from '../../areas/billing/transitions/index.js';
import { joinAdmissionExpired } from './join.expiry.js';
import { liveDiscounts, priceDiscount, resolveDiscount, takeDiscountCycle, takeDiscountUses, type ResolvedDiscount } from '../../areas/billing/discounts/apply.js';
import type { GymSettings } from '../../core/interfaces/gym-settings.js';
import joinMessages from '../../../../../locales/en/public/join.json' with { type: 'json' };

const t = createTranslator(locales.en ?? {});
/** Fixed same-origin return pages, never request values. Checkout and its reservation last an hour. */
export const joinCheckoutFlow: CheckoutReturn = { successPath: '/join/return', cancelPath: '/join/cancelled', lifetimeMs: 60 * 60 * 1000 };
/** Join's form and admission bodies: a family's chosen PNG files (256 KB each) or dozens of drawn signatures. */
export const joinBodyBytes = 4 * 1024 * 1024;
const linkLifetimeMs = 24 * 60 * 60 * 1000, settled = ['paid', 'partially_refunded', 'refunded'];
// Join records are audits on the new household: identifiers only, never contact details.
// `discountId` is the discount a code named at admission; older admissions have none.
const admitted = z.strictObject({ planId: c.idSchema, joinedOn: c.dateSchema, memberIds: z.array(c.idSchema), membershipIds: z.array(c.idSchema),
  discountId: c.idSchema.optional() });
const received = admitted.extend({ linkId: c.idSchema, invoiceId: c.idSchema });
/** The uses a join took, written in the transaction that took them and assigned its memberships, so a replay takes none. */
const discounted = z.strictObject({ discountId: c.idSchema, uses: z.int32().positive(), membershipIds: z.array(c.idSchema) });
const codeFormat = /^[A-Za-z0-9-]{3,40}$/;
const joinText = createTranslator({ 'public/join': joinMessages });
/** Every refused code (unknown, malformed, without a code, off, ended, used up, another plan, too few uses) gets this one answer. */
function codeRefused(): never { throw new AppError('invalid_request', joinText('public/join:codeRefused'), { reason: ['code_refused'] }); }
const isRefusal = (error: unknown) => error instanceof AppError && error.details?.reason?.[0] === 'discount_unknown';
const invoiced = z.strictObject({ invoiceId: c.idSchema, next: z.array(z.strictObject({ membershipId: c.idSchema, nextDueOn: c.dateSchema })) });
/** `closed`: unpaid, and staff voided the invoice or revoked the join's link, so it can no longer be paid here. */
export interface JoinInvoice { amountCents: number; currency: string; lines: { description: string; amountCents: number }[] }
export type JoinState ={ status: 'missing' | 'closed' } | { status: 'pending' | 'active' | 'manual'; householdId: string; cardOnly?: boolean };

export interface JoinOptions {
  scope?: typeof forGym;
  clock?: Clock;
  waivers: Pick<WaiversService, 'listTemplates' | 'uploadSignature' | 'sign'>;
  /** The signed-link Checkout service whose sessions the webhook records and completes. */
  checkout: Pick<ReturnType<typeof createSignedLinkCheckout>, 'start'>;
  /** Checked with the billing switch before any household or Checkout session is created. */
  paymentsConfigured(gymId: string): Promise<boolean>;
  /** The runtime's portal invitation service: its login-link sender and password-mode rule. */
  invitations: Pick<PortalInvitationService, 'accept' | 'passwordRequired'>;
  accounts: Pick<AccountService, 'provisionUser'>;
  invitationStore?: Pick<ReturnType<typeof createPortalInvitationStore>, 'issue'>;
  memberships?: Pick<ReturnType<typeof createMembershipService>, 'assign' | 'get' | 'update' | 'activate'>;
  links?: Pick<ReturnType<typeof createSignedLinksService>, 'create' | 'revoke'>;
  uploadsFor?(gymId: string): Promise<Uploads>;
  /** The runtime's payments resolver: the nightly cleanup confirms an unpaid join's Checkout sessions closed before voiding it. */
  paymentsFor?(gymId: string): Promise<Payments | null>;
}
function missing(): never { throw new AppError('not_found', 'Join not found'); }
function unavailable(): never { throw new AppError('unavailable', 'Online joining is not available'); }
function invalid(message: string): never { throw new AppError('invalid_request', message); }
function changed(): never { throw new AppError('conflict', 'Review the current membership and waivers before submitting'); }
const snapshot = ({ gymId: _gymId, anniversaryOn: _anniversaryOn, switchOverrideReason: _reason, scheduledOrigin: _origin, ...row }: typeof memberships.$inferSelect) =>
  c.membershipSchema.parse({ ...row,
  createdAt: row.createdAt.toISOString(), frozenAt: row.frozenAt?.toISOString() ?? null, cancelledAt: row.cancelledAt?.toISOString() ?? null });
const plan = (row: typeof plans.$inferSelect, plusTax: boolean) => c.publicPlanSchema.parse({ id: row.id, name: row.name, amountCents: row.amountCents,
  currency: row.currency, interval: row.interval, plusTax, signupFeeCents: row.signupFeeCents, trialDays: row.trialDays,
  commitmentMonths: row.commitmentMonths, revision: row.revision });
/**
 * The plans among `ids` that invoicing adds tax to: an attached rate that is exclusive and above zero. Every
 * attached rate counts, archived or not, as the join and cycle invoices read `plan_tax_rates` without filtering
 * them. The first period and the sign-up fee share these rates.
 */
async function plansPlusTax(tx: Transaction, ids: readonly string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await tx.selectDistinct({ planId: planTaxRates.planId }).from(planTaxRates)
    .innerJoin(taxRates, eq(taxRates.id, planTaxRates.taxRateId))
    .where(and(inArray(planTaxRates.planId, [...ids]), addsTaxOnTop));
  return new Set(rows.map(row => row.planId));
}
/** Active plans in the gym's currency, including trials and free plans. */
const joinable = (currency: string) => and(eq(plans.active, true), eq(plans.currency, currency));
async function recorded<T extends z.ZodType>(tx: Transaction, action: string, householdId: string, schema: T): Promise<z.infer<T> | null> {
  const [row] = await tx.select({ after: auditEvents.after }).from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, householdId))).limit(1);
  return row ? schema.parse(row.after) : null;
}
const marked = async (tx: Transaction, action: string, householdId: string) => (await tx.select({ id: auditEvents.id }).from(auditEvents)
  .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, householdId))).limit(1)).length > 0;

export function createJoinService(options: JoinOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const settings = (gymId: string) => scope(gymId, tx => readGymSettings(tx, gymId));
  // No assignment callback: the join issues one first invoice with every first period and sign-up fee.
  const lifecycle = options.memberships ?? createMembershipService({ scope, clock, settings: createGymSettingsAccessor({ scope, clock }) });
  const links = options.links ?? createSignedLinksService({ scope, clock, allowZeroInvoices: true });
  const store = options.invitationStore ?? createPortalInvitationStore();
  const transitions = createInvoiceTransitions({ scope, clock });
  const cleanup = createJoinCleanup({ scope, clock, uploadsFor: gymId => {
    if (!options.uploadsFor) unavailable();
    return options.uploadsFor(gymId);
  }, ...(options.paymentsFor ? { paymentsFor: options.paymentsFor } : {}) });
  const audit = (tx: Transaction, gymId: string, action: string, targetType: string, targetId: string, after?: unknown, before?: unknown) =>
    writeAudit(tx, { gymId, actorKind: 'system', action, targetType, targetId, occurredAt: clock.now(),
      ...(after === undefined ? {} : { after }), ...(before === undefined ? {} : { before }) });

  function applicants(contact: c.PublicContact, people: readonly c.PublicApplicant[], timezone: string) {
    const today = localDate(clock.now(), timezone);
    if (contact.name.length > 200 || contact.email.length > 254 || (contact.phone?.length ?? 0) > 100
      || people.some(p => p.dateOfBirth > today || p.firstName.length > 200 || p.lastName.length > 200)) invalid('Invalid applicant');
  }
  function signers(people: readonly { member: c.PublicApplicant; signatures: readonly { signer: c.WaiverSigner }[] }[], timezone: string) {
    for (const person of people) for (const { signer } of person.signatures) {
      if (needsGuardian(person.member.dateOfBirth, clock.now(), timezone) && signer.kind !== 'guardian') invalid('A parent or guardian must sign for a minor');
      if (signer.name.length > 200 || signer.kind === 'guardian' && signer.relationship.length > 100) invalid('Signer details too long');
    }
  }
  /** The plan row when it can be paid for online; a submission needs no tax lookup. */
  async function joinableRow(gymId: string, planId: string) {
    return scope(gymId, async tx => joinableIn(tx, (await readGymSettings(tx, gymId)).currency, planId));
  }
  async function joinableIn(tx: Transaction, currency: string, planId: string) {
    const [row] = await tx.select().from(plans).where(and(eq(plans.id, planId), joinable(currency)));
    return row ?? missing();
  }
  /** The plan as the join page shows it, with whether invoicing adds tax on top; the currency, the plan and its rates are read in one transaction. */
  async function joinablePlan(gymId: string, planId: string) {
    return scope(gymId, async tx => {
      const gym = await readGymSettings(tx, gymId);
      const row = await joinableIn(tx, gym.currency, planId);
      return plan(row, (await plansPlusTax(tx, [row.id])).has(row.id));
    });
  }
  /** Billing on, a payment provider, and one to eight current documents, all before anything is written. */
  async function ready(gymId: string) {
    if (!(await settings(gymId)).billingEnabled || !await options.paymentsConfigured(gymId)) unavailable();
    const page = await options.waivers.listTemplates(gymId, { limit: 100, offset: 0 });
    if (!page.data.length || page.pagination.total > c.maxJoinDocuments) unavailable();
    return page.data;
  }
  function current(templates: readonly c.WaiverTemplate[], accepted: readonly { templateId: string; templateVersion: number }[]) {
    if (accepted.length !== templates.length || templates.some(tp => !accepted.some(a => a.templateId === tp.id && a.templateVersion === tp.version))) changed();
  }
  /** The private image keys name the admitted members; the submission must repeat exactly what was admitted. */
  async function admission(gymId: string, input: c.PublicJoinRequest) {
    const key = new RegExp(`^${gymId}/waivers/([0-9a-f-]{36})/signatures/[0-9a-f-]{36}\\.png$`);
    const ids = input.members.map(m => {
      const owners = new Set(m.waivers.map(w => key.exec(w.signatureImageKey)?.[1]));
      const [id] = owners;
      return owners.size === 1 && id && c.idSchema.safeParse(id).success ? id : missing();
    });
    if (new Set(ids).size !== ids.length) missing();
    return scope(gymId, async tx => {
      const people = await tx.select().from(members).where(inArray(members.id, ids));
      const householdId = people[0]?.householdId;
      if (people.length !== ids.length || !householdId || people.some(p => p.householdId !== householdId)) missing();
      const [home] = await tx.select().from(households).where(eq(households.id, householdId));
      const record = await recorded(tx, 'public.join.admitted', householdId, admitted);
      // A leaked staff image key cannot enroll, edit, or sign for an existing member.
      if (!home || !record || record.planId !== input.planId || record.memberIds.length !== ids.length || home.email !== input.contact.email
        || home.name !== input.contact.name || home.phone !== (input.contact.phone ?? null) || !isDeepStrictEqual(home.address, input.contact.address ?? {})) missing();
      const membershipIds = ids.map((id, i) => {
        const index = record.memberIds.indexOf(id), person = people.find(p => p.id === id)!, requested = input.members[i]!.member;
        if (index < 0 || person.anonymizedAt || !['prospect', 'trial', 'active'].includes(person.status) || person.firstName !== requested.firstName
          || person.lastName !== requested.lastName || person.dateOfBirth !== requested.dateOfBirth) missing();
        return record.membershipIds[index]!;
      });
      return { householdId, memberIds: ids, membershipIds, joinedOn: record.joinedOn, discountId: record.discountId };
    });
  }
  /** The discount a code names for this plan with a use for each of `count` people, under its row lock. Every refusal is the neutral one. */
  async function checkCode(tx: Transaction, code: string, planId: string, count: number, timezone: string): Promise<ResolvedDiscount> {
    // The lookup reads only this gym's discounts (row-level security), by code: a discount without one is never found.
    if (!codeFormat.test(code)) codeRefused();
    let resolved: ResolvedDiscount;
    try { resolved = await resolveDiscount(tx, { code }, { planIds: [planId], timezone, clock, audience: 'public' }); }
    catch (error) { if (isRefusal(error)) codeRefused(); throw error; }
    if (resolved.row.maxUses !== null && resolved.row.maxUses - resolved.row.uses < count) codeRefused();
    return resolved;
  }
  /**
   * Takes every use the join needs under the discount's row lock, assigns its memberships with the discount and records the
   * uses, in one transaction: all of them or none. A replay finds the record and takes nothing.
   */
  async function assignDiscounted(gymId: string, planId: string, found: Awaited<ReturnType<typeof admission>>, code: string | undefined) {
    await scope(gymId, async tx => {
      const [home] = await tx.select({ id: households.id }).from(households).where(eq(households.id, found.householdId)).for('update');
      if (!home || await marked(tx, 'public.join.cleanup.started', home.id)) missing();
      if (await recorded(tx, 'public.join.discounted', home.id, discounted)) return;
      if (!code || !found.discountId) codeRefused();
      const gym = await readGymSettings(tx, gymId), count = found.memberIds.length;
      const resolved = await checkCode(tx, code, planId, count, gym.timezone);
      if (resolved.row.id !== found.discountId) codeRefused();
      try { await takeDiscountUses(tx, system(gymId), clock, resolved, count); }
      catch (error) { if (isRefusal(error)) codeRefused(); throw error; }
      const settings: GymSettings = { gymId, timezone: gym.timezone, currency: gym.currency, billingEnabled: gym.billingEnabled,
        memberEmailsEnabled: gym.memberEmailsEnabled, websiteEnabled: gym.websiteEnabled, bookingWindowDays: gym.bookingWindowDays,
        cancellationCutoffMinutes: gym.cancellationCutoffMinutes, openMatCountsAsClass: gym.openMatCountsAsClass, revision: gym.revision };
      // The membership service runs in this transaction, so the uses, the memberships and their discounts commit together.
      const within = createMembershipService({ scope: async (_gymId, work) => work(tx), clock, settings: { get: async () => settings } });
      for (const [i, memberId] of found.memberIds.entries())
        await within.assign(system(gymId), { id: found.membershipIds[i]!, householdId: home.id, memberId, planId, startsOn: found.joinedOn,
          nextDueOn: found.joinedOn, initialStatus: 'pending', firstPeriod: 'next_billing_date', discount: { discountId: resolved.row.id }, discountUseTaken: true });
      await audit(tx, gymId, 'public.join.discounted', 'household', home.id,
        discounted.parse({ discountId: resolved.row.id, uses: count, membershipIds: found.membershipIds }));
    });
  }
  /** The first period of every membership and the sign-up fees, as the new household's first cycle. */
  async function invoice(gymId: string, householdId: string, row: typeof plans.$inferSelect, membershipIds: readonly string[], today: string) {
    return scope(gymId, async tx => {
      const [home] = await tx.select().from(households).where(eq(households.id, householdId)).for('update');
      if (!home) missing();
      const previous = await recorded(tx, 'public.join.invoiced', householdId, invoiced);
      if (previous) return previous;
      const rows = await tx.select().from(memberships).where(inArray(memberships.id, [...membershipIds])).for('update');
      if (rows.length !== membershipIds.length
        || rows.some(r => r.householdId !== home.id || r.status !== 'pending' || r.startsOn !== today || r.nextDueOn !== (r.trialEndsOn ?? today))) changed();
      // Assignment fixes the trial dates, even if the plan changed since admission or changes again now.
      const trialEndsOn = rows[0]!.trialEndsOn, billingDay = Number((trialEndsOn ?? today).slice(8));
      if (rows.some(r => r.trialEndsOn !== trialEndsOn)) changed();
      if (home.billingDay !== billingDay) {
        // Admission set the join day; another day means staff chose one. Unrelated household edits don't block the join.
        if (home.billingDay !== Number(today.slice(8))) changed();
        const guard = revisionGuard(households.revision, home.revision);
        assertRevised(await tx.update(households).set({ billingDay, revision: guard.next })
          .where(and(eq(households.id, home.id), guard.matches)).returning({ id: households.id }));
        await audit(tx, gymId, 'billing.household.anchor_set', 'household', home.id,
          { billingDay, revision: home.revision + 1 }, { billingDay: home.billingDay, revision: home.revision });
      }
      const currency = c.currencySchema.parse(row.currency);
      const taxes = await tx.select({ id: taxRates.id, name: taxRates.name, rateMillionths: taxRates.rateMillionths, inclusive: taxRates.inclusive })
        .from(planTaxRates).innerJoin(taxRates, eq(taxRates.id, planTaxRates.taxRateId)).where(eq(planTaxRates.planId, row.id)).orderBy(asc(taxRates.id));
      // A code's discount was applied at assignment: its locked-in terms price the first period, and its fee waiver drops that
      // membership's sign-up fee. A waiver-only application ends at assignment, so the first application of each counts.
      const applications = new Map<string, typeof membershipDiscounts.$inferSelect>();
      for (const applied of await tx.select().from(membershipDiscounts).where(inArray(membershipDiscounts.membershipId, [...membershipIds]))
        .orderBy(asc(membershipDiscounts.appliedAt), asc(membershipDiscounts.id))) if (!applications.has(applied.membershipId)) applications.set(applied.membershipId, applied);
      const price = (id: string) => {
        const applied = applications.get(id), discount = applied && applied.endedAt === null ? priceDiscount(applied) : undefined;
        return discount ? { discount } : {};
      };
      // Priced as the runner prices an active membership on its due date; the memberships stay pending until it is paid.
      const cycle = trialEndsOn !== null ? null : calculateCycleInvoice({ householdId: home.id, currency, billingDay, familyDiscountBasisPoints: home.familyDiscountBasisPoints,
        discountDescription: t('billing/runner:familyDiscount'), dueOn: today, memberships: rows.map(r => ({ membership: { ...snapshot(r), status: 'active' as const },
          description: row.name, taxRates: taxes, ...price(r.id), ...(r.anniversaryOn === null ? {} : { annualAnchorOn: r.anniversaryOn }) })) });
      if (cycle && !cycle.invoice) changed();
      const charged = rows.filter(r => !applications.get(r.id)?.waivesSignupFee);
      const fees = row.signupFeeCents > 0 && charged.length ? calculateOneOffInvoice({ householdId: home.id, currency, dueOn: today, charges: charged.map(r => ({
        kind: 'signup_fee' as const, description: t('billing/runner:signupFee', { plan: row.name }), membershipId: r.id, planId: r.planId,
        amountCents: row.signupFeeCents, currency, taxRates: taxes })) }) : null;
      // A trial owes only its sign-up fee now; its first full period is due when the trial ends.
      // Trial invoices have no membership lines: the generic paid-invoice effect would activate trials early.
      const base = cycle?.invoice ?? { householdId: home.id, currency, kind: 'cycle' as const, dueOn: today,
        periodStartsOn: today, periodEndsOn: trialEndsOn!, amountCents: 0,
        lineItems: [] };
      const invoiceId = await issue(tx, system(gymId), clock, { ...base,
        amountCents: base.amountCents + (fees?.amountCents ?? 0), lineItems: [...base.lineItems, ...(fees?.lineItems ?? [])] });
      // The first cycle is a full period, so a once or cycles discount uses one cycle here, once (the record below ends replays). A trial uses none.
      if (cycle) for (const r of rows) await takeDiscountCycle(tx, system(gymId), clock, r.id);
      const result = invoiced.parse({ invoiceId, next: trialEndsOn !== null ? [] : cycle!.nextDueDates.map(d => ({ membershipId: d.membershipId, nextDueOn: d.nextDueOn })) });
      await audit(tx, gymId, 'public.join.invoiced', 'household', home.id, result);
      return result;
    });
  }
  /** A payer invitation for the household's own address. It grants nothing until accepted with that account's proof. */
  async function invite(gymId: string, householdId: string, email: string, name: string) {
    let result = { status: 'refused' } as { status: 'invited'; token: string } | { status: 'linked' | 'refused' };
    await options.accounts.provisionUser(gymId, email, name, clock, async (tx, userId) => {
      // Staff identities are never claimed through a member invitation.
      if ((await tx.select({ id: staffRoles.id }).from(staffRoles).where(eq(staffRoles.userId, userId)).limit(1)).length) return;
      await assertPortalLoginTarget(tx, householdId, null, 'payer', clock);
      if ((await tx.select({ id: householdUsers.id }).from(householdUsers).where(and(eq(householdUsers.householdId, householdId),
        eq(householdUsers.userId, userId)))).length) { result = { status: 'linked' }; return; }
      const issued = await store.issue(tx, gymId, { userId, householdId, scope: 'payer', memberId: null }, clock);
      await audit(tx, gymId, 'household_user.invited', 'household', householdId, { userId, scope: 'payer', memberId: null });
      result = { status: 'invited', token: issued.token };
    });
    return result;
  }
  async function household(gymId: string, householdId: string) {
    const [home] = await scope(gymId, tx => tx.select({ id: households.id, email: households.email, name: households.name }).from(households).where(eq(households.id, householdId)));
    return home?.email ? { ...home, email: home.email } : missing();
  }
  /** Passwordless: a login link to the address entered. The payer login is created on its callback, for the user it names. */
  async function signIn(gymId: string, householdId: string) {
    const home = await household(gymId, householdId), invitation = await invite(gymId, householdId, home.email, home.name);
    if (invitation.status === 'invited') await options.invitations.accept(gymId, { token: invitation.token }, clock);
  }
  /** Once the join's invoice is paid, the joined prospects become trial or active members and the join completes, once.
   * Passwordless, the payer's sign-in link goes out with it; in password mode the address awaits staff confirmation. */
  async function complete(gymId: string, find: (tx: Transaction) => Promise<{ householdId: string; invoiceId?: string } | undefined>) {
    // Every paid invoice and link-tagged Checkout reaches this: one short read, and only an unfinished join goes on.
    const householdId = await scope(gymId, async tx => {
      const found = await find(tx), record = found ? await recorded(tx, 'public.join.received', found.householdId, received) : null;
      return found && record && (!found.invoiceId || record.invoiceId === found.invoiceId) && !await marked(tx, 'public.join.completed', found.householdId)
        ? found.householdId : null;
    });
    if (!householdId) return;
    const passwordMode = await options.invitations.passwordRequired(gymId);
    const completed = await scope(gymId, async tx => {
      await tx.select({ id: households.id }).from(households).where(eq(households.id, householdId)).for('update');
      const record = await recorded(tx, 'public.join.received', householdId, received);
      if (!record) return false;
      const [bill] = await tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, record.invoiceId));
      if (!bill || !settled.includes(bill.status) || await marked(tx, 'public.join.completed', householdId)) return false;
      const joinedMemberships = await tx.select().from(memberships).where(and(eq(memberships.householdId, householdId),
        inArray(memberships.id, record.membershipIds))).for('update');
      // Joining keeps trials pending until payment/card setup is recorded. Start the trial atomically with completion.
      for (const membership of joinedMemberships) {
        if (membership.status !== 'pending' || !membership.trialEndsOn) continue;
        const guard = revisionGuard(memberships.revision, membership.revision);
        assertRevised(await tx.update(memberships).set({ status: 'trial', revision: guard.next })
          .where(and(eq(memberships.id, membership.id), guard.matches)).returning({ id: memberships.id }));
        await audit(tx, gymId, 'public.join.trial_started', 'membership', membership.id, { status: 'trial', revision: membership.revision + 1 },
          { status: membership.status, revision: membership.revision });
      }
      for (const person of await tx.select().from(members).where(inArray(members.id, record.memberIds)).for('update')) {
        if (person.status !== 'prospect' || person.anonymizedAt) continue;
        const status = joinedMemberships.some(m => m.memberId === person.id && m.trialEndsOn && ['pending', 'trial'].includes(m.status)) ? 'trial' : 'active';
        await tx.update(members).set({ status, revision: person.revision + 1 }).where(and(eq(members.id, person.id), eq(members.revision, person.revision)));
        await audit(tx, gymId, 'public.join.member_activated', 'member', person.id, { status, revision: person.revision + 1 },
          { status: person.status, revision: person.revision });
      }
      await audit(tx, gymId, 'public.join.completed', 'household', householdId);
      // No mail proves the address in password mode: staff check the person, then issue a printed invitation.
      if (passwordMode) await requestPortalConfirmation(tx, gymId, householdId, clock);
      return true;
    });
    if (!completed || passwordMode) return;
    // The payment is recorded; a delivery problem must not fail it. The return page can send the link again.
    try { await signIn(gymId, householdId); }
    catch (error) { logError('public.join.sign_in_failed', { gymId, householdId }, error); }
  }
  async function settleFree(gymId: string, householdId: string) {
    const saved = await scope(gymId, async tx => {
      const record = await recorded(tx, 'public.join.received', householdId, received);
      if (!record) return null;
      const [bill] = await tx.select().from(invoices).where(eq(invoices.id, record.invoiceId));
      if (!bill || bill.amountCents !== 0 || bill.status === 'void') return null;
      const [link] = await tx.select().from(signedLinks).where(eq(signedLinks.id, record.linkId));
      if (!link || link.revokedAt) return null;
      if (link.purpose === 'update_card') {
        if (!link.usedAt || !(await tx.select({ id: paymentMethods.id }).from(paymentMethods)
          .where(and(eq(paymentMethods.householdId, householdId), isNull(paymentMethods.revokedAt))).limit(1)).length) return null;
      }
      return record;
    });
    if (!saved) return;
    await transitions.settleZero(system(gymId), { invoiceId: saved.invoiceId });
    for (const id of saved.membershipIds) {
      const membership = await lifecycle.get(gymId, id);
      if (membership.status === 'pending' && !membership.trialEndsOn) {
        try { await lifecycle.activate(system(gymId), { membershipId: id, revision: membership.revision }); }
        catch (error) { if (!(error instanceof AppError && error.code === 'conflict') || (await lifecycle.get(gymId, id)).status === 'pending') throw error; }
      }
    }
    await complete(gymId, async () => ({ householdId, invoiceId: saved.invoiceId }));
  }
  const service = {
    cleanup,
    ready, joinablePlan,
    passwordMode: (gymId: string) => options.invitations.passwordRequired(gymId),
    async plans(gymId: string, query: c.Pagination) {
      return scope(gymId, async tx => {
        const where = joinable((await readGymSettings(tx, gymId)).currency), total = await tx.$count(plans, where);
        const rows = await tx.select().from(plans).where(where).orderBy(asc(plans.name), asc(plans.id)).limit(query.limit).offset(query.offset);
        const taxed = await plansPlusTax(tx, rows.map(row => row.id));
        return c.publicPlanListResponseSchema.parse({ data: rows.map(row => plan(row, taxed.has(row.id))), pagination: { ...query, total } });
      });
    },
    async branding(gymId: string) {
      const gym = await settings(gymId);
      return c.publicBrandingSchema.parse({ name: gym.name, revision: gym.revision, logoKey: gym.branding.logoKey ?? null, primaryColor: gym.branding.primaryColor ?? null });
    },
    /** Creates the new household and its prospects, then stores each validated signature image. Never looks up an address. */
    async admit(gymId: string, body: unknown, timezone: string) {
      const input = c.joinAdmissionSchema.parse(body);
      applicants(input.contact, input.members.map(m => m.member), timezone);
      signers(input.members, timezone);
      await joinableRow(gymId, input.planId);
      const templates = await ready(gymId);
      input.members.forEach(m => current(templates, m.signatures));
      const images = input.members.map(m => m.signatures.map(s => Buffer.from(s.pngBase64, 'base64')));
      images.flat().forEach(validateSignatureImage);
      const today = localDate(clock.now(), timezone), code = input.code || undefined;
      const memberIds = await scope(gymId, async tx => {
        // A refused code writes nothing. A code that works is only checked here; the uses are taken at submission.
        const discountId = code === undefined ? undefined : (await checkCode(tx, code, input.planId, input.members.length, timezone)).row.id;
        const now = clock.now(), householdId = uuidv7(now.getTime()), ids = input.members.map(() => uuidv7(now.getTime()));
        await tx.insert(households).values({ id: householdId, gymId, name: input.contact.name, email: input.contact.email,
          phone: input.contact.phone ?? null, address: input.contact.address ?? {}, billingDay: Number(today.slice(8)), createdAt: now });
        await tx.insert(members).values(input.members.map((m, i) => ({ id: ids[i]!, gymId, householdId, ...m.member,
          email: input.contact.email, status: 'prospect', createdAt: now })));
        await audit(tx, gymId, 'household.created', 'household', householdId);
        // The join date is fixed here, so a submission retried after midnight repeats the same memberships.
        await audit(tx, gymId, 'public.join.admitted', 'household', householdId,
          admitted.parse({ planId: input.planId, joinedOn: today, memberIds: ids, membershipIds: ids.map(() => uuidv7(now.getTime())),
            ...(discountId === undefined ? {} : { discountId }) }));
        return { ids, householdId };
      });
      const data = [];
      const uploaded: string[] = [];
      try {
        for (const [i, person] of input.members.entries()) {
          const stored = [];
          for (const [j, accepted] of person.signatures.entries()) {
            const image = await options.waivers.uploadSignature(system(gymId), memberIds.ids[i]!, images[i]![j]!);
            uploaded.push(image.signatureImageKey);
            stored.push({ templateId: accepted.templateId, templateVersion: accepted.templateVersion, ...image });
          }
          data.push(stored);
        }
        await scope(gymId, async tx => {
          const [home] = await tx.select({ id: households.id }).from(households).where(eq(households.id, memberIds.householdId)).for('update');
          if (!home || await marked(tx, 'public.join.cleanup.started', home.id)) missing();
        });
        return c.joinAdmissionResponseSchema.parse({ data });
      } catch (error) {
        // Best effort: the caller sees the original error, and the daily cleanup retries what fails here.
        if (options.uploadsFor) {
          try {
            const uploads = await options.uploadsFor(gymId);
            for (const key of uploaded) await uploads.markDeleted(key);
          } catch (failure) { logError('public.join.admit_cleanup_failed', { gymId, householdId: memberIds.householdId }, failure); }
          try { await cleanup.remove(gymId, memberIds.householdId); }
          catch (failure) { logError('public.join.admit_cleanup_failed', { gymId, householdId: memberIds.householdId }, failure); }
        }
        throw error;
      }
    },
    /** Signs, assigns pending memberships, issues the first invoice and an undisclosed pay link. Replays return the same join. */
    async join(gymId: string, body: unknown, timezone: string, ipAddress: string) {
      const input = c.publicJoinRequestSchema.parse(body);
      if (input.members.length > c.maxJoinMembers) invalid('Too many members');
      applicants(input.contact, input.members.map(m => m.member), timezone);
      signers(input.members.map(m => ({ member: m.member, signatures: m.waivers })), timezone);
      const selectedPlan = await joinableRow(gymId, input.planId);
      const templates = await ready(gymId);
      input.members.forEach(m => current(templates, m.waivers));
      const found = await admission(gymId, input), today = found.joinedOn;
      const done = await scope(gymId, tx => recorded(tx, 'public.join.received', found.householdId, received));
      if (done) { await settleFree(gymId, found.householdId); return { linkId: done.linkId }; }
      // A day's grace for midnight; an older admission would start memberships, and bill periods, in the past.
      if (joinAdmissionExpired(today, clock.now(), timezone)) changed();
      for (const m of input.members) if (needsGuardian(m.member.dateOfBirth, clock.now(), timezone) && m.waivers.some(w => w.signer.kind !== 'guardian'))
        invalid('A parent or guardian must sign for a minor');
      // The code must be the one admitted. Leaving it out continues without the discount; once the join has taken its
      // uses, it keeps them, with or without the code. A refusal here comes before anything is signed or taken.
      const code = input.code || undefined;
      const discountTaken = await scope(gymId, async tx => {
        if (await recorded(tx, 'public.join.discounted', found.householdId, discounted)) return true;
        if (code === undefined) return false;
        if (!found.discountId || (await checkCode(tx, code, input.planId, found.memberIds.length, timezone)).row.id !== found.discountId) codeRefused();
        return false;
      });
      await scope(gymId, async tx => {
        const [home] = await tx.select({ id: households.id }).from(households).where(eq(households.id, found.householdId)).for('update');
        if (!home || await marked(tx, 'public.join.cleanup.started', home.id)) missing();
        if (!await marked(tx, 'public.join.submitting', home.id)) await audit(tx, gymId, 'public.join.submitting', 'household', home.id);
        const now = clock.now();
        for (const memberId of found.memberIds) await recordLeadIntake(tx, { gymId, memberId, source: 'join', now });
      });
      for (const [i, m] of input.members.entries()) for (const acceptance of m.waivers)
        await options.waivers.sign(system(gymId), { ...acceptance, memberId: found.memberIds[i]! }, { timezone, ipAddress });
      if (!await scope(gymId, tx => signedLinkWaiversComplete(tx, found.memberIds))) changed();
      if (discountTaken || code !== undefined) await assignDiscounted(gymId, input.planId, found, code);
      else for (const [i, memberId] of found.memberIds.entries())
        await lifecycle.assign(system(gymId), { id: found.membershipIds[i]!, householdId: found.householdId, memberId, planId: input.planId,
          startsOn: today, nextDueOn: today, initialStatus: 'pending', firstPeriod: 'next_billing_date' });
      const first = await invoice(gymId, found.householdId, selectedPlan, found.membershipIds, today);
      // Each membership is next due on the join-date anniversary; its annual anniversary keeps the join date (February 29 included).
      for (const change of first.next) {
        const membership = await lifecycle.get(gymId, change.membershipId);
        if (membership.status !== 'pending' || membership.nextDueOn !== today) continue;
        try { await lifecycle.update(system(gymId), { membershipId: change.membershipId, revision: membership.revision, nextDueOn: change.nextDueOn }); }
        catch (error) {
          if (!(error instanceof AppError && error.code === 'conflict') || (await lifecycle.get(gymId, change.membershipId)).nextDueOn !== change.nextDueOn) throw error;
        }
      }
      const purpose = await scope(gymId, async tx => {
        const [bill] = await tx.select().from(invoices).where(eq(invoices.id, first.invoiceId));
        const assigned = await tx.select({ id: memberships.id, amountCents: memberships.amountCents }).from(memberships).where(inArray(memberships.id, found.membershipIds));
        // A card is needed only for a later charge: a forever discount that covers the whole price leaves none.
        const live = await liveDiscounts(tx, found.membershipIds);
        const later = assigned.some(m => {
          const applied = live.get(m.id);
          return m.amountCents > 0 && !(applied?.duration === 'forever' && (applied.percentBasisPoints === 10_000 || (applied.amountCents ?? 0) >= m.amountCents));
        });
        return bill!.amountCents === 0 && later ? 'update_card' as const : 'pay_invoice' as const;
      });
      const [reusable] = await scope(gymId, tx => tx.select({ id: signedLinks.id }).from(signedLinks).where(and(eq(signedLinks.householdId, found.householdId),
        eq(signedLinks.purpose, purpose), purpose === 'pay_invoice' ? eq(signedLinks.invoiceId, first.invoiceId) : undefined,
        isNull(signedLinks.revokedAt), isNull(signedLinks.usedAt))).limit(1));
      // The link's token is never disclosed: the link only binds Checkout and its webhook completion to this invoice.
      const linkId = reusable?.id ?? (await links.create(system(gymId), { ...(purpose === 'pay_invoice' ? { purpose, invoiceId: first.invoiceId } : { purpose }), householdId: found.householdId,
        expiresAt: new Date(clock.now().getTime() + linkLifetimeMs).toISOString() })).link.id;
      const kept = await scope(gymId, async tx => {
        await tx.select({ id: households.id }).from(households).where(eq(households.id, found.householdId)).for('update');
        const winner = await recorded(tx, 'public.join.received', found.householdId, received);
        if (winner) return winner.linkId;
        await audit(tx, gymId, 'public.join.received', 'household', found.householdId,
          received.parse({ planId: input.planId, joinedOn: today, memberIds: found.memberIds, membershipIds: found.membershipIds, invoiceId: first.invoiceId, linkId }));
        return linkId;
      });
      if (kept !== linkId && !reusable) await links.revoke(system(gymId), linkId);
      await settleFree(gymId, found.householdId);
      return { linkId: kept };
    },
    /** Starts or reuses the short Checkout for the pending join, returning to the fixed join pages. */
    async checkout(gymId: string, linkId: string) {
      return (await options.checkout.start(gymId, linkId, false, joinCheckoutFlow)).session.url;
    },
    /** Read-only: ready only after settlement, membership start and join completion. Trials count as started. */
    async state(gymId: string, linkId: string): Promise<JoinState> {
      return scope(gymId, async tx => {
        const [link] = await tx.select({ householdId: signedLinks.householdId, revokedAt: signedLinks.revokedAt, purpose: signedLinks.purpose }).from(signedLinks).where(eq(signedLinks.id, linkId));
        const record = link ? await recorded(tx, 'public.join.received', link.householdId, received) : null;
        if (!link || !record || record.linkId !== linkId) return { status: 'missing' };
        const [bill] = await tx.select({ status: invoices.status, amountCents: invoices.amountCents, currency: invoices.currency }).from(invoices).where(eq(invoices.id, record.invoiceId));
        // A paid invoice wins over a revoked link: staff may have collected it another way.
        if (!bill || !settled.includes(bill.status))
          return bill?.status === 'void' || link.revokedAt ? { status: 'closed' }
            : { status: bill && bill.amountCents > 0 && ['open', 'past_due'].includes(bill.status) && cardChargeIssue(bill.amountCents, bill.currency) ? 'manual' : 'pending',
              householdId: link.householdId, cardOnly: link.purpose === 'update_card' };
        const rows = await tx.select({ status: memberships.status }).from(memberships).where(inArray(memberships.id, record.membershipIds));
        const active = rows.length === record.membershipIds.length && rows.every(r => r.status !== 'pending') && await marked(tx, 'public.join.completed', link.householdId);
        return { status: active ? 'active' : 'pending', householdId: link.householdId, cardOnly: link.purpose === 'update_card' };
      });
    },
    /** The pending join's first invoice for the review step: its lines (a code's discount among them, inclusive taxes left out) and total. */
    async firstInvoice(gymId: string, linkId: string): Promise<JoinInvoice | null> {
      return scope(gymId, async tx => {
        const [link] = await tx.select({ householdId: signedLinks.householdId }).from(signedLinks).where(eq(signedLinks.id, linkId));
        const record = link ? await recorded(tx, 'public.join.received', link.householdId, received) : null;
        if (!link || !record || record.linkId !== linkId) return null;
        const [bill] = await tx.select({ amountCents: invoices.amountCents, currency: invoices.currency }).from(invoices).where(eq(invoices.id, record.invoiceId));
        if (!bill) return null;
        const lines = await tx.select({ kind: invoiceLineItems.kind, description: invoiceLineItems.description, amountCents: invoiceLineItems.amountCents,
          taxInclusive: invoiceLineItems.taxInclusive }).from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, record.invoiceId));
        // Line IDs carry no order within one invoice: list the periods, their discounts, the fees, then the taxes.
        const order = ['membership', 'discount', 'signup_fee', 'charge', 'tax'];
        return { amountCents: bill.amountCents, currency: bill.currency,
          lines: lines.filter(line => !(line.kind === 'tax' && line.taxInclusive))
            .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.description.localeCompare(b.description))
            .map(({ description, amountCents }) => ({ description, amountCents })) };
      });
    },
    /** Webhook only, after a payment or card is recorded: once the join's invoice is paid, by its own Checkout or any
     * other link of its household, the joined prospects become trial or active members, once. */
    async afterCheckout(gymId: string, linkId: string) {
      const [link] = await scope(gymId, tx => tx.select({ householdId: signedLinks.householdId }).from(signedLinks).where(eq(signedLinks.id, linkId)));
      if (link) await settleFree(gymId, link.householdId);
      await complete(gymId, async tx => (await tx.select({ householdId: signedLinks.householdId }).from(signedLinks).where(eq(signedLinks.id, linkId)))[0]);
    },
    /** The invoice transitions' paid-invoice hook, after the memberships activate: completes a join however its invoice
     * was paid (staff-recorded cash or check, a later pay link), idempotent with `afterCheckout`. */
    async afterInvoicePaid(gymId: string, invoiceId: string) {
      await complete(gymId, async tx => (await tx.select({ householdId: invoices.householdId, invoiceId: invoices.id }).from(invoices).where(eq(invoices.id, invoiceId)))[0]);
    },
    /** Passwordless: a new sign-in link replaces the previous one. The same response whatever the address. */
    async resend(gymId: string, linkId: string) {
      if (await options.invitations.passwordRequired(gymId)) throw new AppError('forbidden', 'Password login is enabled');
      const state = await service.state(gymId, linkId);
      if (state.status !== 'active') throw new AppError('conflict', 'The membership is not active yet');
      await signIn(gymId, state.householdId);
    },
  };
  return service;
}
export type JoinService = ReturnType<typeof createJoinService>;
