// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { forGym, auditEvents, households, householdUsers, invoices, members, memberships, plans, planTaxRates, signedLinks,
  staffRoles, taxRates, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, createTranslator, type Clock } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import * as c from '@plaingym/shared/contracts';
import { addDays, localDate } from '@plaingym/shared/time';
import { z } from 'zod';
import { clock as defaultClock } from '../../core/clock.js';
import { logError } from '../../core/log.js';
import { createGymSettingsAccessor, createSettingsService } from '../../areas/settings/settings.js';
import { signedLinkWaiversComplete, type WaiversService } from '../../areas/waivers/waivers.js';
import { needsGuardian, validateSignatureImage } from '../../areas/waivers/snapshot.js';
import { createMembershipService } from '../../areas/billing/memberships.js';
import { calculateCycleInvoice, calculateOneOffInvoice } from '../../areas/billing/invoicing/index.js';
import { issue, system } from '../../areas/billing/runner/store.js';
import type { CheckoutReturn, createSignedLinkCheckout } from '../../areas/billing/signed-link-checkout.js';
import { createSignedLinksService } from '../../areas/links/service.js';
import { assertPortalLoginTarget } from '../../areas/members/household-users.js';
import type { PortalInvitationService } from '../../areas/members/household-users.invitations.js';
import type { AccountService } from '../../infra/auth/accounts.js';
import { createPortalInvitationStore } from '../../infra/auth/portal-invitations.js';

const t = createTranslator(locales.en ?? {});
/** Fixed same-origin return pages, never request values. Checkout and its reservation last an hour. */
export const joinCheckoutFlow: CheckoutReturn = { successPath: '/join/return', cancelPath: '/join/cancelled', lifetimeMs: 60 * 60 * 1000 };
export const maxJoinMembers = 6, maxJoinDocuments = 8;
const linkLifetimeMs = 24 * 60 * 60 * 1000, settled = ['paid', 'partially_refunded', 'refunded'];
const upload = z.strictObject({ templateId: c.idSchema, templateVersion: c.waiverTemplateVersionSchema,
  pngBase64: z.string().min(1).max(350_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) });
// The upload admission is separate from the frozen, existence-blind join submission.
// TODO(CCR): move this schema and POST /join/signatures into the shared public contracts with the drop-in admission.
export const joinAdmissionSchema = z.strictObject({
  planId: c.idSchema, contact: c.publicContactSchema, honeypot: z.literal(''),
  members: z.array(z.strictObject({ member: c.publicApplicantSchema, signatures: z.array(upload).min(1).max(maxJoinDocuments) })).min(1).max(maxJoinMembers),
});
export const joinAdmissionResponseSchema = z.strictObject({ data: z.array(z.array(z.strictObject({
  templateId: c.idSchema, templateVersion: z.number(), signatureImageKey: z.string(), signatureImageHash: z.string() }))) });
// Join records are audits on the new household: identifiers only, never contact details.
const admitted = z.strictObject({ planId: c.idSchema, joinedOn: c.dateSchema, memberIds: z.array(c.idSchema), membershipIds: z.array(c.idSchema) });
const received = admitted.extend({ linkId: c.idSchema, invoiceId: c.idSchema });
const invoiced = z.strictObject({ invoiceId: c.idSchema, next: z.array(z.strictObject({ membershipId: c.idSchema, nextDueOn: c.dateSchema })) });
export type JoinState = { status: 'missing' } | { status: 'pending' | 'active'; householdId: string };
export type JoinInvitation = { status: 'invited'; token: string } | { status: 'linked' | 'refused' };

export interface JoinOptions {
  scope?: typeof forGym;
  clock?: Clock;
  settings?: Pick<ReturnType<typeof createSettingsService>, 'get'>;
  waivers: Pick<WaiversService, 'listTemplates' | 'uploadSignature' | 'sign'>;
  /** The signed-link Checkout service whose sessions the webhook records and completes. */
  checkout: Pick<ReturnType<typeof createSignedLinkCheckout>, 'start'>;
  /** Checked with the billing switch before any household or Checkout session is created. */
  paymentsConfigured(gymId: string): Promise<boolean>;
  /** The runtime's portal invitation service: its login-link sender and password-mode rule. */
  invitations: Pick<PortalInvitationService, 'accept' | 'passwordRequired'>;
  accounts: Pick<AccountService, 'findUserByEmail' | 'provisionUser' | 'hasPassword'>;
  invitationStore?: Pick<ReturnType<typeof createPortalInvitationStore>, 'issue'>;
  memberships?: Pick<ReturnType<typeof createMembershipService>, 'assign' | 'get' | 'update'>;
  links?: Pick<ReturnType<typeof createSignedLinksService>, 'create' | 'revoke'>;
}
function missing(): never { throw new AppError('not_found', 'Join not found'); }
function unavailable(): never { throw new AppError('unavailable', 'Online joining is not available'); }
function invalid(message: string): never { throw new AppError('invalid_request', message); }
function changed(): never { throw new AppError('conflict', 'Review the current membership and waivers before submitting'); }
const snapshot = ({ gymId: _gymId, anniversaryOn: _anniversaryOn, ...row }: typeof memberships.$inferSelect) => c.membershipSchema.parse({ ...row,
  createdAt: row.createdAt.toISOString(), frozenAt: row.frozenAt?.toISOString() ?? null, cancelledAt: row.cancelledAt?.toISOString() ?? null });
const plan = (row: typeof plans.$inferSelect) => c.publicPlanSchema.parse({ id: row.id, name: row.name, amountCents: row.amountCents,
  currency: row.currency, interval: row.interval, signupFeeCents: row.signupFeeCents, trialDays: row.trialDays,
  commitmentMonths: row.commitmentMonths, revision: row.revision });
/** Plans a visitor can pay for now: a trial or a free first period has no Checkout payment to collect. */
const joinable = (currency: string) => and(eq(plans.active, true), eq(plans.trialDays, 0), gt(plans.amountCents, 0), eq(plans.currency, currency));
async function recorded<T extends z.ZodType>(tx: Transaction, action: string, householdId: string, schema: T): Promise<z.infer<T> | null> {
  const [row] = await tx.select({ after: auditEvents.after }).from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, householdId))).limit(1);
  return row ? schema.parse(row.after) : null;
}
const marked = async (tx: Transaction, action: string, householdId: string) => (await tx.select({ id: auditEvents.id }).from(auditEvents)
  .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, householdId))).limit(1)).length > 0;

export function createJoinService(options: JoinOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const settings = options.settings ?? createSettingsService({ scope, clock });
  // No assignment callback: the join issues one first invoice with every first period and sign-up fee.
  const lifecycle = options.memberships ?? createMembershipService({ scope, clock, settings: createGymSettingsAccessor({ scope, clock }) });
  const links = options.links ?? createSignedLinksService({ scope, clock });
  const store = options.invitationStore ?? createPortalInvitationStore();
  const audit = (tx: Transaction, gymId: string, action: string, targetType: string, targetId: string, after?: unknown, before?: unknown) =>
    writeAudit(tx, { gymId, actorKind: 'system', action, targetType, targetId, occurredAt: clock.now(),
      ...(after === undefined ? {} : { after }), ...(before === undefined ? {} : { before }) });

  function applicants(contact: c.PublicContact, people: readonly c.PublicApplicant[], timezone: string) {
    const today = localDate(clock.now(), timezone);
    if (contact.name.length > 200 || contact.email.length > 254 || (contact.phone?.length ?? 0) > 100
      || people.some(p => p.dateOfBirth > today || p.firstName.length > 200 || p.lastName.length > 200)) invalid('Invalid applicant');
  }
  async function joinablePlan(gymId: string, planId: string) {
    const gym = await settings.get(gymId);
    const [row] = await scope(gymId, tx => tx.select().from(plans).where(and(eq(plans.id, planId), joinable(gym.currency))));
    return row ? plan(row) : missing();
  }
  /** Billing on, a payment provider, and one to eight current documents, all before anything is written. */
  async function ready(gymId: string) {
    if (!(await settings.get(gymId)).billingEnabled || !await options.paymentsConfigured(gymId)) unavailable();
    const page = await options.waivers.listTemplates(gymId, { limit: 100, offset: 0 });
    if (!page.data.length || page.pagination.total > maxJoinDocuments) unavailable();
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
        if (index < 0 || person.anonymizedAt || !['prospect', 'active'].includes(person.status) || person.firstName !== requested.firstName
          || person.lastName !== requested.lastName || person.dateOfBirth !== requested.dateOfBirth) missing();
        return record.membershipIds[index]!;
      });
      return { householdId, memberIds: ids, membershipIds, joinedOn: record.joinedOn };
    });
  }
  /** The first period of every membership and the sign-up fees, as the new household's first cycle. */
  async function invoice(gymId: string, householdId: string, planId: string, membershipIds: readonly string[], today: string) {
    return scope(gymId, async tx => {
      const [home] = await tx.select().from(households).where(eq(households.id, householdId)).for('update');
      if (!home) missing();
      const previous = await recorded(tx, 'public.join.invoiced', householdId, invoiced);
      if (previous) return previous;
      const rows = await tx.select().from(memberships).where(inArray(memberships.id, [...membershipIds])).for('update');
      // The admission set the new household's billing day to its join date.
      const billingDay = Number(today.slice(8));
      if (home.billingDay !== billingDay || rows.length !== membershipIds.length
        || rows.some(r => r.householdId !== home.id || r.status !== 'pending' || r.startsOn !== today || r.nextDueOn !== today)) changed();
      const [row] = await tx.select().from(plans).where(eq(plans.id, planId));
      if (!row) missing();
      const currency = c.currencySchema.parse(row.currency);
      const taxes = await tx.select({ id: taxRates.id, name: taxRates.name, rateMillionths: taxRates.rateMillionths, inclusive: taxRates.inclusive })
        .from(planTaxRates).innerJoin(taxRates, eq(taxRates.id, planTaxRates.taxRateId)).where(eq(planTaxRates.planId, planId)).orderBy(asc(taxRates.id));
      // Priced as the runner prices an active membership on its due date; the memberships stay pending until it is paid.
      const cycle = calculateCycleInvoice({ householdId: home.id, currency, billingDay, familyDiscountBasisPoints: home.familyDiscountBasisPoints,
        discountDescription: t('billing/runner:familyDiscount'), dueOn: today, memberships: rows.map(r => ({ membership: { ...snapshot(r), status: 'active' as const },
          description: row.name, taxRates: taxes, ...(r.anniversaryOn === null ? {} : { annualAnchorOn: r.anniversaryOn }) })) });
      if (!cycle.invoice) changed();
      const fees = row.signupFeeCents > 0 ? calculateOneOffInvoice({ householdId: home.id, currency, dueOn: today, charges: rows.map(r => ({
        kind: 'signup_fee' as const, description: t('billing/runner:signupFee', { plan: row.name }), membershipId: r.id,
        amountCents: row.signupFeeCents, currency, taxRates: taxes })) }) : null;
      const invoiceId = await issue(tx, system(gymId), clock, { ...cycle.invoice,
        amountCents: cycle.invoice.amountCents + (fees?.amountCents ?? 0), lineItems: [...cycle.invoice.lineItems, ...(fees?.lineItems ?? [])] });
      const result = invoiced.parse({ invoiceId, next: cycle.nextDueDates.map(d => ({ membershipId: d.membershipId, nextDueOn: d.nextDueOn })) });
      await audit(tx, gymId, 'public.join.invoiced', 'household', home.id, result);
      return result;
    });
  }
  /** A payer invitation for the household's own address. It grants nothing until accepted with that account's proof. */
  async function invite(gymId: string, householdId: string, email: string, name: string) {
    let result = { status: 'refused' } as { status: 'invited'; token: string; userId: string } | { status: 'linked' | 'refused' };
    await options.accounts.provisionUser(gymId, email, name, clock, async (tx, userId) => {
      // Staff identities are never claimed through a member invitation.
      if ((await tx.select({ id: staffRoles.id }).from(staffRoles).where(eq(staffRoles.userId, userId)).limit(1)).length) return;
      await assertPortalLoginTarget(tx, householdId, null, 'payer', clock);
      if ((await tx.select({ id: householdUsers.id }).from(householdUsers).where(and(eq(householdUsers.householdId, householdId),
        eq(householdUsers.userId, userId)))).length) { result = { status: 'linked' }; return; }
      const issued = await store.issue(tx, gymId, { userId, householdId, scope: 'payer', memberId: null }, clock);
      await audit(tx, gymId, 'household_user.invited', 'household', householdId, { userId, scope: 'payer', memberId: null });
      result = { status: 'invited', token: issued.token, userId };
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
  const service = {
    ready, joinablePlan,
    passwordMode: (gymId: string) => options.invitations.passwordRequired(gymId),
    async plans(gymId: string, query: c.Pagination) {
      const gym = await settings.get(gymId);
      return scope(gymId, async tx => {
        const where = joinable(gym.currency), total = await tx.$count(plans, where);
        const rows = await tx.select().from(plans).where(where).orderBy(asc(plans.name), asc(plans.id)).limit(query.limit).offset(query.offset);
        return c.publicPlanListResponseSchema.parse({ data: rows.map(plan), pagination: { ...query, total } });
      });
    },
    async branding(gymId: string) {
      const gym = await settings.get(gymId);
      return c.publicBrandingSchema.parse({ name: gym.name, revision: gym.revision, logoKey: gym.branding.logoKey ?? null, primaryColor: gym.branding.primaryColor ?? null });
    },
    /** Creates the new household and its prospects, then stores each validated signature image. Never looks up an address. */
    async admit(gymId: string, body: unknown, timezone: string) {
      const input = joinAdmissionSchema.parse(body);
      applicants(input.contact, input.members.map(m => m.member), timezone);
      await joinablePlan(gymId, input.planId);
      const templates = await ready(gymId);
      input.members.forEach(m => current(templates, m.signatures));
      const images = input.members.map(m => m.signatures.map(s => Buffer.from(s.pngBase64, 'base64')));
      images.flat().forEach(validateSignatureImage);
      const today = localDate(clock.now(), timezone);
      const memberIds = await scope(gymId, async tx => {
        const now = clock.now(), householdId = uuidv7(now.getTime()), ids = input.members.map(() => uuidv7(now.getTime()));
        await tx.insert(households).values({ id: householdId, gymId, name: input.contact.name, email: input.contact.email,
          phone: input.contact.phone ?? null, address: input.contact.address ?? {}, billingDay: Number(today.slice(8)), createdAt: now });
        await tx.insert(members).values(input.members.map((m, i) => ({ id: ids[i]!, gymId, householdId, ...m.member,
          email: input.contact.email, status: 'prospect', createdAt: now })));
        await audit(tx, gymId, 'household.created', 'household', householdId);
        // The join date is fixed here, so a submission retried after midnight repeats the same memberships.
        await audit(tx, gymId, 'public.join.admitted', 'household', householdId,
          admitted.parse({ planId: input.planId, joinedOn: today, memberIds: ids, membershipIds: ids.map(() => uuidv7(now.getTime())) }));
        return ids;
      });
      const data = [];
      for (const [i, person] of input.members.entries()) {
        const stored = [];
        for (const [j, accepted] of person.signatures.entries())
          stored.push({ templateId: accepted.templateId, templateVersion: accepted.templateVersion,
            ...await options.waivers.uploadSignature(system(gymId), memberIds[i]!, images[i]![j]!) });
        data.push(stored);
      }
      return joinAdmissionResponseSchema.parse({ data });
    },
    /** Signs, assigns pending memberships, issues the first invoice and an undisclosed pay link. Replays return the same join. */
    async join(gymId: string, body: unknown, timezone: string, ipAddress: string) {
      const input = c.publicJoinRequestSchema.parse(body);
      if (input.members.length > maxJoinMembers) invalid('Too many members');
      applicants(input.contact, input.members.map(m => m.member), timezone);
      await joinablePlan(gymId, input.planId);
      const templates = await ready(gymId);
      input.members.forEach(m => current(templates, m.waivers));
      const found = await admission(gymId, input), today = found.joinedOn;
      const done = await scope(gymId, tx => recorded(tx, 'public.join.received', found.householdId, received));
      if (done) return { linkId: done.linkId };
      // A day's grace for midnight; an older admission would start memberships, and bill periods, in the past.
      if (addDays(today, 1) < localDate(clock.now(), timezone)) changed();
      for (const m of input.members) if (needsGuardian(m.member.dateOfBirth, clock.now(), timezone) && m.waivers.some(w => w.signer.kind !== 'guardian'))
        invalid('A parent or guardian must sign for a minor');
      for (const [i, m] of input.members.entries()) for (const acceptance of m.waivers)
        await options.waivers.sign(system(gymId), { ...acceptance, memberId: found.memberIds[i]! }, { timezone, ipAddress });
      if (!await scope(gymId, tx => signedLinkWaiversComplete(tx, found.memberIds))) changed();
      for (const [i, memberId] of found.memberIds.entries())
        await lifecycle.assign(system(gymId), { id: found.membershipIds[i]!, householdId: found.householdId, memberId, planId: input.planId,
          startsOn: today, nextDueOn: today, initialStatus: 'pending', firstPeriod: 'next_billing_date' });
      const first = await invoice(gymId, found.householdId, input.planId, found.membershipIds, today);
      // Each membership is next due on the join-date anniversary; its annual anniversary keeps the join date (February 29 included).
      for (const change of first.next) {
        const membership = await lifecycle.get(gymId, change.membershipId);
        if (membership.status !== 'pending' || membership.nextDueOn !== today) continue;
        try { await lifecycle.update(system(gymId), { membershipId: change.membershipId, revision: membership.revision, nextDueOn: change.nextDueOn }); }
        catch (error) {
          if (!(error instanceof AppError && error.code === 'conflict') || (await lifecycle.get(gymId, change.membershipId)).nextDueOn !== change.nextDueOn) throw error;
        }
      }
      const [reusable] = await scope(gymId, tx => tx.select({ id: signedLinks.id }).from(signedLinks).where(and(eq(signedLinks.householdId, found.householdId),
        eq(signedLinks.invoiceId, first.invoiceId), eq(signedLinks.purpose, 'pay_invoice'), isNull(signedLinks.revokedAt), isNull(signedLinks.usedAt))).limit(1));
      // The link's token is never disclosed: the link only binds Checkout and its webhook completion to this invoice.
      const linkId = reusable?.id ?? (await links.create(system(gymId), { purpose: 'pay_invoice', householdId: found.householdId, invoiceId: first.invoiceId,
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
      return { linkId: kept };
    },
    /** Starts or reuses the short Checkout for the pending join, returning to the fixed join pages. */
    async checkout(gymId: string, linkId: string) {
      return (await options.checkout.start(gymId, linkId, false, joinCheckoutFlow)).session.url;
    },
    /** Read-only: active only after the webhook paid the invoice, activated the memberships and completed the join. */
    async state(gymId: string, linkId: string): Promise<JoinState> {
      return scope(gymId, async tx => {
        const [link] = await tx.select({ householdId: signedLinks.householdId }).from(signedLinks).where(eq(signedLinks.id, linkId));
        const record = link ? await recorded(tx, 'public.join.received', link.householdId, received) : null;
        if (!link || !record || record.linkId !== linkId) return { status: 'missing' };
        const [bill] = await tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, record.invoiceId));
        const rows = await tx.select({ status: memberships.status }).from(memberships).where(inArray(memberships.id, record.membershipIds));
        const active = !!bill && settled.includes(bill.status) && rows.every(r => r.status !== 'pending') && await marked(tx, 'public.join.completed', link.householdId);
        return { status: active ? 'active' : 'pending', householdId: link.householdId };
      });
    },
    /** Webhook only, after a payment or card is recorded: once the join's invoice is paid, by its own Checkout or any
     * other link of its household, the joined prospects become active members, once. */
    async afterCheckout(gymId: string, linkId: string) {
      const completed = await scope(gymId, async tx => {
        const [link] = await tx.select({ householdId: signedLinks.householdId }).from(signedLinks).where(eq(signedLinks.id, linkId));
        // Every link-tagged Checkout reaches this hook; only a joined household is locked.
        const record = link ? await recorded(tx, 'public.join.received', link.householdId, received) : null;
        if (!link || !record) return null;
        await tx.select({ id: households.id }).from(households).where(eq(households.id, link.householdId)).for('update');
        const [bill] = await tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, record.invoiceId));
        if (!bill || !settled.includes(bill.status) || await marked(tx, 'public.join.completed', link.householdId)) return null;
        for (const person of await tx.select().from(members).where(inArray(members.id, record.memberIds)).for('update')) {
          if (person.status !== 'prospect' || person.anonymizedAt) continue;
          await tx.update(members).set({ status: 'active', revision: person.revision + 1 }).where(and(eq(members.id, person.id), eq(members.revision, person.revision)));
          await audit(tx, gymId, 'public.join.member_activated', 'member', person.id, { status: 'active', revision: person.revision + 1 },
            { status: person.status, revision: person.revision });
        }
        await audit(tx, gymId, 'public.join.completed', 'household', link.householdId);
        return link.householdId;
      });
      if (!completed || await options.invitations.passwordRequired(gymId)) return;
      // The payment is recorded; a delivery problem must not fail it. The return page can send the link again.
      try { await signIn(gymId, completed); }
      catch (error) { logError('public.join.sign_in_failed', { gymId, householdId: completed }, error); }
    },
    /** Passwordless: a new sign-in link replaces the previous one. The same response whatever the address. */
    async resend(gymId: string, linkId: string) {
      if (await options.invitations.passwordRequired(gymId)) throw new AppError('forbidden', 'Password login is enabled');
      const state = await service.state(gymId, linkId);
      if (state.status !== 'active') throw new AppError('conflict', 'The membership is not active yet');
      await signIn(gymId, state.householdId);
    },
    /** Password mode: an invitation for the claim page, which proves the account with its password. An existing
     * account without a password is never given one here; only an account this join created can set its first password. */
    async passwordLogin(gymId: string, linkId: string): Promise<JoinInvitation> {
      if (!await options.invitations.passwordRequired(gymId)) throw new AppError('forbidden', 'Password login is disabled');
      const state = await service.state(gymId, linkId);
      if (state.status !== 'active') throw new AppError('conflict', 'The membership is not active yet');
      const home = await household(gymId, state.householdId), existing = await options.accounts.findUserByEmail(home.email);
      if (existing && !await options.accounts.hasPassword(existing.id) && !await scope(gymId, async tx =>
        (await recorded(tx, 'public.join.account_created', home.id, z.strictObject({ userId: c.idSchema })))?.userId === existing.id)) return { status: 'refused' };
      const invitation = await invite(gymId, home.id, home.email, home.name);
      if (invitation.status === 'invited' && !existing) await scope(gymId, async tx => {
        if (!await marked(tx, 'public.join.account_created', home.id)) await audit(tx, gymId, 'public.join.account_created', 'household', home.id, { userId: invitation.userId });
      });
      return invitation.status === 'invited' ? { status: 'invited', token: invitation.token } : invitation;
    },
  };
  return service;
}
export type JoinService = ReturnType<typeof createJoinService>;
