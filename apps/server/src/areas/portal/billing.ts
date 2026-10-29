// SPDX-License-Identifier: AGPL-3.0-only
import { forHousehold, uuidv7 } from '@plaingym/db';
import { AppError, createTranslator, type Clock, type Translator } from '@plaingym/shared';
import {
  portalInvoiceDetailSchema, portalInvoiceListQuerySchema, portalInvoiceSchema, portalPaymentMethodsResponseSchema,
  type PortalInvoice, type PortalInvoiceDetail,
} from '@plaingym/shared/contracts';
import type { MemberHouseholdContext, PortalIdentity } from '../../core/interfaces/member-household.js';
import { notFound } from '../../core/interfaces/common.js';
import { clock as defaultClock } from '../../core/clock.js';
import type { Uploads } from '../../infra/storage/index.js';
import { renderPdf } from '../../infra/pdf/index.js';
import type { CheckoutSession } from '../../infra/payments/index.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { householdReader, type HouseholdQueries } from './household.js';
import { createSignedLinksService } from '../links/service.js';
import { createSettingsService } from '../settings/settings.js';
import messages from '../../../../../locales/en/portal/billing.json' with { type: 'json' };

type InvoiceRow = Awaited<ReturnType<HouseholdQueries['invoices']>>[number];
type LineRow = Awaited<ReturnType<HouseholdQueries['invoiceLines']>>[number];
/** The signed-link Checkout service (C2.4), shared with `/l/*`: customer creation, card-saving policy and recovery. */
export interface PortalCheckout { start(gymId: string, linkId: string): Promise<{ session: CheckoutSession; expiresAt: string }> }
export interface PortalBillingOptions {
  households?: MemberHouseholdContext; householdScope?: typeof forHousehold; clock?: Clock;
  links?: Pick<ReturnType<typeof createSignedLinksService>, 'create' | 'revoke' | 'list'>;
  checkout: () => PortalCheckout;
  uploadsFor: () => (gymId: string) => Promise<Uploads>;
  render?: typeof renderPdf;
  t?: Translator;
  /** The gym's display name for receipts; defaults to the gym settings. */
  gymName?: (gymId: string) => Promise<string>;
}
/** A started Checkout and the internal link it belongs to; the token never reaches the browser's page script. */
export interface PortalCheckoutStart { session: CheckoutSession; expiresAt: string; linkId: string; token: string }
const receiptStatuses = new Set(['paid', 'partially_refunded', 'refunded']);
/** Gyms have no locale setting; receipts format like the signed-link pages, which also default to English. */
const receiptLocale = 'en';
/** Long enough to finish a Checkout; the session itself expires within 23 hours. */
const checkoutLinkLifetimeMs = 24 * 60 * 60 * 1000;

export function createPortalBillingService(options: PortalBillingOptions) {
  const households = options.households ?? createMemberHouseholdContext(), scope = options.householdScope ?? forHousehold;
  const clock = options.clock ?? defaultClock, links = options.links ?? createSignedLinksService({ clock });
  const t = options.t ?? createTranslator({ 'portal/billing': messages });
  const gymName = options.gymName ?? (async (gymId: string) => (await createSettingsService({ clock }).get(gymId)).name);
  const read = householdReader(scope);
  /** Only the payer reaches billing: the role check here, and the household grant again in every query. */
  const payer = (identity: PortalIdentity) => households.requirePayer(identity, 'billing.manage');
  const invoice = (row: InvoiceRow): PortalInvoice => portalInvoiceSchema.parse({ id: row.id, number: row.number, kind: row.kind, status: row.status,
    dueOn: row.dueOn, amountCents: row.amountCents, currency: row.currency, paidAt: row.paidAt?.toISOString() ?? null });
  const line = (row: LineRow) => ({ id: row.id, kind: row.kind, description: row.description, amountCents: row.amountCents,
    currency: row.currency, quantity: row.quantity, taxRateMillionths: row.taxRateMillionths, taxInclusive: row.taxInclusive });
  async function detail(identity: PortalIdentity, invoiceId: string): Promise<PortalInvoiceDetail> {
    await payer(identity);
    return read(identity, async queries => {
      const [row] = await queries.invoice(invoiceId);
      if (!row || row.status === 'draft') notFound();
      return portalInvoiceDetailSchema.parse({ invoice: invoice(row), lines: (await queries.invoiceLines(row.id)).map(line) });
    });
  }
  /** Mints a single-use link for this household, never shown to anyone, and starts the shared Checkout for it. */
  async function checkout(identity: PortalIdentity, request: { purpose: 'pay_invoice'; invoiceId: string } | { purpose: 'update_card' }): Promise<PortalCheckoutStart> {
    const created = await links.create({ gymId: identity.gymId, actor: { kind: 'user', userId: identity.userId } },
      { householdId: identity.householdId, expiresAt: new Date(clock.now().getTime() + checkoutLinkLifetimeMs).toISOString(), ...request });
    const system = { gymId: identity.gymId, actor: { kind: 'system' as const } };
    let started: Awaited<ReturnType<PortalCheckout['start']>>;
    try { started = await options.checkout().start(identity.gymId, created.link.id); }
    catch (error) {
      await links.revoke(system, created.link.id).catch(() => undefined);
      throw error;
    }
    // Only the newest attempt stays usable: earlier unused links from this login for the same purpose are revoked.
    // A payment or card from an older Checkout is still recorded by the webhook; only its link page closes.
    const earlier = await links.list(identity.gymId, { householdId: identity.householdId, purpose: request.purpose, limit: 100, offset: 0 });
    for (const link of earlier.data) if (link.id !== created.link.id && link.createdBy === identity.userId && !link.usedAt && !link.revokedAt
      && (request.purpose !== 'pay_invoice' || link.invoiceId === request.invoiceId)) await links.revoke(system, link.id).catch(() => undefined);
    return { ...started, linkId: created.link.id, token: created.token };
  }
  return {
    async list(identity: PortalIdentity, input: unknown) {
      const query = portalInvoiceListQuerySchema.parse(input);
      await payer(identity);
      const rows = (await read(identity, queries => queries.invoices())).filter(row => row.status !== 'draft' && (!query.status || row.status === query.status))
        .sort((a, b) => b.dueOn.localeCompare(a.dueOn) || (b.number ?? 0) - (a.number ?? 0) || b.id.localeCompare(a.id));
      return { data: rows.slice(query.offset, query.offset + query.limit).map(invoice), pagination: { limit: query.limit, offset: query.offset, total: rows.length } };
    },
    get: detail,
    /** A short-lived PDF for a paid invoice, stored like waiver PDFs: deleted on write and swept later. */
    async receipt(identity: PortalIdentity, invoiceId: string, timezone: string) {
      const { invoice: row, lines } = await detail(identity, invoiceId);
      if (!row.paidAt || !receiptStatuses.has(row.status)) throw new AppError('conflict', 'Invoice has no receipt yet');
      const money = (cents: number) => new Intl.NumberFormat(receiptLocale, { style: 'currency', currency: row.currency }).format(cents / 100);
      const paidAt = new Date(row.paidAt), gym = await gymName(identity.gymId);
      // A refunded receipt shows its status; the refunded amount isn't in the household's invoice queries.
      const bytes = await (options.render ?? renderPdf)({ title: t('portal/billing:receiptTitle', { number: row.number }), createdAt: paidAt,
        footer: t('portal/billing:receiptFooter', { gym, number: row.number }), blocks: [
          { kind: 'text', text: gym, size: 14 },
          { kind: 'text', text: t('portal/billing:receiptTitle', { number: row.number }), size: 18 },
          { kind: 'text', text: t('portal/billing:receiptPaid', { date: new Intl.DateTimeFormat(receiptLocale, { timeZone: timezone, dateStyle: 'medium' }).format(paidAt) }) },
          ...lines.map(item => ({ kind: 'text' as const, text: `${item.description} × ${item.quantity}: ${money(item.amountCents)}` })),
          { kind: 'text', text: t('portal/billing:receiptTotal', { amount: money(row.amountCents) }), size: 14 },
          ...(row.status === 'paid' ? [] : [{ kind: 'text' as const, text: t('portal/billing:status_' + row.status) }]),
        ] });
      const uploads = await options.uploadsFor()(identity.gymId), key = `${identity.gymId}/receipts/${row.id}/${uuidv7(clock.now().getTime())}.pdf`;
      // Demo sandboxes refuse general uploads, so receipts are unavailable there.
      try { await uploads.put(key, bytes, 'application/pdf'); }
      catch (error) { if (error instanceof AppError && error.code === 'forbidden') throw new AppError('unavailable', 'Receipts are not available'); throw error; }
      await uploads.markDeleted(key);
      const url = await uploads.signedUrl(key, 300);
      if (!url) throw new AppError('unavailable', 'Receipt is not available');
      return { url, expiresAt: new Date(clock.now().getTime() + 300_000).toISOString() };
    },
    /** Invoice state changes only through the invoice transitions, when the Checkout's payment is recorded. */
    async pay(identity: PortalIdentity, invoiceId: string) {
      const { invoice: row } = await detail(identity, invoiceId);
      if (!['open', 'past_due'].includes(row.status)) throw new AppError('conflict', 'Invoice cannot be paid');
      return checkout(identity, { purpose: 'pay_invoice', invoiceId: row.id });
    },
    async paymentMethods(identity: PortalIdentity) {
      await payer(identity);
      const rows = (await read(identity, queries => queries.paymentMethods()))
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id));
      return portalPaymentMethodsResponseSchema.shape.data.parse(rows);
    },
    /** Checkout in setup mode; the shared idempotent card writer records the card from the webhook or a verified return. */
    async updateCard(identity: PortalIdentity) {
      await payer(identity);
      // The card grant comes from the household boundary too, before a link is minted outside it.
      await read(identity, queries => queries.paymentMethods());
      return checkout(identity, { purpose: 'update_card' });
    },
  };
}
export type PortalBillingService = ReturnType<typeof createPortalBillingService>;
