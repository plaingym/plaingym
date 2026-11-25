// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, ne } from 'drizzle-orm';
import {
  auditEvents, forGym, households, invoices, linkCampaigns, members, signedLinks, uuidv7, writeAudit,
  type Transaction,
} from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { cardChargeIssue } from '@plaingym/shared/money';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import {
  campaignLimits, createSignedLinkRequestSchema, idSchema, sendSignedLinkRequestSchema, signedLinkListQuerySchema, signedLinkSchema,
  type CreateSignedLinkRequest, type SendSignedLinkRequest, type SignedLinkRecord, type SignedLinkListQuery,
} from '@plaingym/shared/contracts';
import { z } from 'zod';
import { clock as defaultClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { commandDigest, createEmailDeliveries, deliveryAcceptance, type Email } from '../../infra/email/index.js';
import { releaseUndisclosed } from '../../infra/email/deliveries.js';
import { createSmsDeliveries, MemberSms } from '../../infra/sms/index.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { deliverSignedLink, householdBoundSmsResolver, signedLinkSmsRecipient, validateSignedLinkDelivery, validateSignedLinkOrigin,
  type SignedLinkDelivery, type SignedLinkSmsDelivery } from './service.delivery.js';
import { completeCampaignIn } from './campaigns.model.js';

type LinkRow = typeof signedLinks.$inferSelect;
export const signedLinkExpiryDays = campaignLimits.expiryDays;
export type SignedLinkPrincipal = Extract<Principal, { kind: 'signed_link' }>;
export type SignedLinkResolution =
  | { readonly status: 'active'; readonly principal: SignedLinkPrincipal }
  | { readonly status: 'used'; readonly processing?: true }
  | { readonly status: 'not_found' | 'expired' | 'revoked' };
export interface LinkScope { readonly gymId: string; readonly linkId: string }
/** What a send command remembers for its replay. */
const sentLinkSchema = z.strictObject({ linkId: idSchema });
const sendRefusalReasons = new Set([
  'household_email_missing',
  'email_disabled',
  'recipient_suppressed',
  'recipient_suppressed_sms',
  'delivery_unavailable',
]);

/** Explicit metadata projection: neither plaintext nor its hash can leave a read or audit. */
function metadata(row: LinkRow): SignedLinkRecord {
  return signedLinkSchema.parse({
    id: row.id, householdId: row.householdId, campaignId: row.campaignId,
    purpose: row.purpose, invoiceId: row.invoiceId, memberId: row.memberId,
    expiresAt: row.expiresAt.toISOString(), usedAt: row.usedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null, createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  });
}
function principal(row: LinkRow): SignedLinkPrincipal {
  const link = metadata(row);
  const resource = link.purpose === 'pay_invoice' ? { purpose: link.purpose, invoiceId: link.invoiceId }
    : link.purpose === 'sign_waiver' || link.purpose === 'unsubscribe' ? { purpose: link.purpose, memberId: link.memberId }
      : { purpose: link.purpose };
  return { kind: 'signed_link', gymId: row.gymId, linkId: row.id, householdId: row.householdId, link: resource };
}
function state(row: LinkRow, now: Date): 'active' | 'used' | 'revoked' | 'expired' {
  // Match the campaign contract's precedence when more than one state applies.
  if (row.usedAt !== null) return 'used';
  if (row.revokedAt !== null) return 'revoked';
  return row.expiresAt <= now ? 'expired' : 'active';
}
function missing(): never { throw new AppError('not_found', 'Signed link or resource not found'); }
function digest(token: string) { return createHash('sha256').update(token).digest('hex'); }
function auditEvent(context: MutationContext, action: string, link: SignedLinkRecord, now: Date,
  before?: SignedLinkRecord): typeof auditEvents.$inferInsert {
  return {
    gymId: context.gymId, actorKind: context.actor.kind,
    ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
    action, targetType: 'signed_link', targetId: link.id, occurredAt: now,
    ...(before ? { before } : {}), after: link,
  };
}
async function audit(tx: Transaction, context: MutationContext, action: string, row: LinkRow, now: Date, before?: LinkRow) {
  await writeAudit(tx, auditEvent(context, action, metadata(row), now, before && metadata(before)));
}
/** Rows per multi-row insert and IDs per lookup, well under PostgreSQL's 65,535 bind parameters. */
const chunkSize = 500;
function chunks<T>(items: T[]) {
  return Array.from({ length: Math.ceil(items.length / chunkSize) }, (_, i) => items.slice(i * chunkSize, (i + 1) * chunkSize));
}
/** Queries distinct IDs in ascending order, a chunk at a time, so row locks are taken in one order across the request. */
async function lookup<T>(ids: string[], query: (chunk: string[]) => Promise<T[]>) {
  const rows: T[] = [];
  for (const chunk of chunks([...new Set(ids)].sort())) rows.push(...await query(chunk));
  return rows;
}
/** IDs compare as text below; PostgreSQL stores and matches UUIDs case-insensitively. */
function lowercaseIds(request: CreateSignedLinkRequest): CreateSignedLinkRequest {
  return { ...request, householdId: request.householdId.toLowerCase(),
    ...(request.campaignId ? { campaignId: request.campaignId.toLowerCase() } : {}),
    ...(request.purpose === 'pay_invoice' ? { invoiceId: request.invoiceId.toLowerCase() } : {}),
    ...(request.purpose === 'sign_waiver' ? { memberId: request.memberId.toLowerCase() } : {}) };
}
/**
 * Checks every request before anything is inserted, with one query per resource kind and chunk of IDs, then reports
 * the first failing request with the error a one-by-one check would raise. Requests after the first expired one are
 * never looked up, and waiver members are locked in ID order.
 */
async function checkResources(tx: Transaction, gymId: string, all: CreateSignedLinkRequest[], now: Date, allowZeroInvoices: boolean) {
  const expired = all.findIndex(request => new Date(request.expiresAt) <= now);
  const requests = expired < 0 ? all : all.slice(0, expired);
  const householdIds = new Set((await lookup(requests.map(r => r.householdId), ids => tx.select({ id: households.id })
    .from(households).where(and(eq(households.gymId, gymId), inArray(households.id, ids))))).map(row => row.id));
  const invoiceHouseholds = new Map((await lookup(requests.flatMap(r => r.purpose === 'pay_invoice' ? [r.invoiceId] : []),
    ids => tx.select({ id: invoices.id, householdId: invoices.householdId, amountCents: invoices.amountCents, status: invoices.status }).from(invoices)
      .where(and(eq(invoices.gymId, gymId), inArray(invoices.id, ids))).orderBy(asc(invoices.id)).for('share'))).map(row => [row.id, row]));
  const waiverMembers = new Map((await lookup(requests.flatMap(r => r.purpose === 'sign_waiver' ? [r.memberId] : []),
    ids => tx.select({ id: members.id, householdId: members.householdId, anonymizedAt: members.anonymizedAt }).from(members)
      .where(and(eq(members.gymId, gymId), inArray(members.id, ids))).orderBy(asc(members.id)).for('update'))).map(row => [row.id, row]));
  const campaignPurposes = new Map((await lookup(requests.flatMap(r => r.campaignId ? [r.campaignId] : []),
    ids => tx.select({ id: linkCampaigns.id, purpose: linkCampaigns.purpose }).from(linkCampaigns)
      .where(and(eq(linkCampaigns.gymId, gymId), inArray(linkCampaigns.id, ids))))).map(row => [row.id, row.purpose]));
  for (const request of requests) {
    if (!householdIds.has(request.householdId)) missing();
    if (request.purpose === 'pay_invoice') {
      const invoice = invoiceHouseholds.get(request.invoiceId);
      if (invoice?.householdId !== request.householdId) missing();
      if (invoice.status === 'void') throw new AppError('conflict', 'Invoice has been voided', { reason: ['not_payable'] });
      if (invoice.amountCents === 0 && !allowZeroInvoices)
        throw new AppError('conflict', 'No payment is needed', { reason: ['zero_invoice'] });
    } else if (request.purpose === 'sign_waiver') {
      const member = waiverMembers.get(request.memberId);
      if (member?.householdId !== request.householdId) missing();
      if (member.anonymizedAt !== null) throw new AppError('conflict', 'Member personal data has been erased');
    }
    if (request.campaignId) {
      const purpose = campaignPurposes.get(request.campaignId);
      if (!purpose) missing();
      if (purpose !== request.purpose) throw new AppError('invalid_request', 'Campaign purpose does not match');
    }
  }
  if (expired >= 0) throw new AppError('invalid_request', 'Signed link expiry must be in the future');
}
/**
 * Creates every link or none inside the caller's transaction: multi-row inserts of the links and their audits, per
 * chunk. Each returned token is shown once; only its digest is stored. IDs ascend in request order, as when each
 * link was created after the one before it.
 */
export async function createSignedLinksIn(tx: Transaction, context: MutationContext, inputs: CreateSignedLinkRequest[], now: Date,
  { allowZeroInvoices = false }: { allowZeroInvoices?: boolean } = {}) {
  const requests = inputs.map(input => lowercaseIds(createSignedLinkRequestSchema.parse(input)));
  if (requests.some(request => new Date(request.expiresAt).getTime() > now.getTime() + signedLinkExpiryDays * 86400000))
    throw new AppError('invalid_request', `Signed links may last at most ${signedLinkExpiryDays} days`,
      { expiresAt: [`Choose an expiry within ${signedLinkExpiryDays} days`] });
  const seen = new Set<string>();
  for (const request of requests) {
    const kind = request.purpose === 'pay_invoice' ? 'invoice' : request.purpose === 'sign_waiver' ? 'member' : 'household';
    const id = request.purpose === 'pay_invoice' ? request.invoiceId : request.purpose === 'sign_waiver' ? request.memberId : request.householdId;
    const key = `${request.purpose}:${id}`;
    if (seen.has(key)) throw new AppError('invalid_request', `${kind === 'invoice' ? 'An' : 'A'} ${kind} may appear only once`);
    seen.add(key);
  }
  await checkResources(tx, context.gymId, requests, now, allowZeroInvoices);
  const ids = requests.map(() => uuidv7()).sort(), auditIds = requests.map(() => uuidv7()).sort();
  const created: { link: SignedLinkRecord; token: string }[] = [];
  for (const [index, chunk] of chunks(requests).entries()) {
    const offset = index * chunkSize, tokens = chunk.map(() => randomBytes(32).toString('base64url'));
    const values = chunk.map((request, i) => ({
      id: ids[offset + i]!, gymId: context.gymId, householdId: request.householdId, purpose: request.purpose,
      tokenHash: digest(tokens[i]!), expiresAt: new Date(request.expiresAt), createdAt: now,
      invoiceId: request.purpose === 'pay_invoice' ? request.invoiceId : null,
      memberId: request.purpose === 'sign_waiver' ? request.memberId : null,
      campaignId: request.campaignId ?? null,
      createdBy: context.actor.kind === 'user' ? context.actor.userId : null,
    }));
    const stored = new Map((await tx.insert(signedLinks).values(values).returning()).map(row => [row.id, row]));
    const links = values.map(value => metadata(stored.get(value.id)!));
    await tx.insert(auditEvents).values(links.map((link, i) => ({
      ...auditEvent(context, 'signed_link.created', link, now), id: auditIds[offset + i]! })));
    created.push(...links.map((link, i) => ({ link, token: tokens[i]! })));
  }
  const campaignIds = [...new Set(requests.flatMap(request => request.campaignId ?? []))].sort();
  for (const ids of chunks(campaignIds))
    await tx.update(linkCampaigns).set({ completedAt: null }).where(and(eq(linkCampaigns.gymId, context.gymId), inArray(linkCampaigns.id, ids)));
  return created;
}

/** The caller's transaction owns the row lock, update and audit for every revocation path. */
export async function revokeSignedLinkIn(tx: Transaction, context: MutationContext, linkId: string, now: Date) {
  const [before] = await tx.select().from(signedLinks).where(and(
    eq(signedLinks.gymId, context.gymId), eq(signedLinks.id, linkId),
  )).for('update');
  if (!before || before.purpose === 'unsubscribe') missing();
  if (before.revokedAt !== null || before.usedAt !== null) return metadata(before);
  const [row] = await tx.update(signedLinks).set({ revokedAt: now }).where(and(
    eq(signedLinks.gymId, context.gymId), eq(signedLinks.id, linkId),
  )).returning();
  await audit(tx, context, 'signed_link.revoked', row!, now, before);
  return metadata(row!);
}

export function createSignedLinksService(options: {
  scope?: typeof forGym;
  clock?: Clock;
  delivery?: SignedLinkDelivery;
  smsDelivery?: SignedLinkSmsDelivery;
  /** Internal settlement flows may need an undisclosed zero-invoice association; staff sharing always refuses it. */
  allowZeroInvoices?: boolean;
} = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const deliveries = createEmailDeliveries({ scope, clock });
  const smsDeliveries = createSmsDeliveries({ scope, clock }), settings = createGymSettingsAccessor({ scope });
  /** Creates every link or none, in one transaction (`createSignedLinksIn`). */
  async function createMany(context: MutationContext, inputs: CreateSignedLinkRequest[]) {
    return scope(context.gymId, tx => createSignedLinksIn(tx, context, inputs, clock.now(), { allowZeroInvoices: options.allowZeroInvoices ?? false }));
  }
  async function create(context: MutationContext, input: CreateSignedLinkRequest) {
    return (await createMany(context, [input]))[0]!;
  }
  async function get(gymId: string, linkId: string) {
    return scope(gymId, async (tx) => {
      const [row] = await tx.select().from(signedLinks).where(and(eq(signedLinks.gymId, gymId), eq(signedLinks.id, linkId)));
      if (!row || row.purpose === 'unsubscribe') missing();
      return metadata(row);
    });
  }
  async function revoke(context: MutationContext, linkId: string) {
    return scope(context.gymId, tx => revokeSignedLinkIn(tx, context, linkId, clock.now()));
  }
  return {
    create, createMany, get, revoke,
    async list(gymId: string, input: Partial<SignedLinkListQuery> = {}) {
      const query = signedLinkListQuerySchema.parse(input);
      return scope(gymId, async (tx) => {
        const filter = and(eq(signedLinks.gymId, gymId), ne(signedLinks.purpose, 'unsubscribe'),
          query.householdId ? eq(signedLinks.householdId, query.householdId) : undefined,
          query.campaignId ? eq(signedLinks.campaignId, query.campaignId) : undefined,
          query.purpose ? eq(signedLinks.purpose, query.purpose) : undefined);
        const [total] = await tx.select({ count: count() }).from(signedLinks).where(filter);
        const rows = await tx.select().from(signedLinks).where(filter)
          .orderBy(desc(signedLinks.createdAt), desc(signedLinks.id)).limit(query.limit).offset(query.offset);
        return { data: rows.map(metadata), pagination: { limit: query.limit, offset: query.offset, total: total!.count } };
      });
    },
    async resolve(gymId: string, token: string, receipt?: { linkId: string; sessionId: string }): Promise<SignedLinkResolution> {
      // Avoid unbounded hashing and never reveal whether a malformed credential has a row.
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) return { status: 'not_found' };
      return scope(gymId, async (tx) => {
        const [row] = await tx.select().from(signedLinks).where(and(
          eq(signedLinks.gymId, gymId), eq(signedLinks.tokenHash, digest(token)),
        ));
        if (!row) return { status: 'not_found' };
        const status = state(row, clock.now());
        if (status === 'used' && receipt?.linkId === row.id && row.purpose === 'pay_invoice' && row.invoiceId
          && !row.revokedAt && row.expiresAt > clock.now()) {
          const [settling] = await tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.id, row.invoiceId),
            eq(invoices.householdId, row.householdId), eq(invoices.checkoutSessionId, receipt.sessionId), eq(invoices.status, 'processing')));
          if (settling) return { status, processing: true };
        }
        return status === 'active' ? { status, principal: principal(row) } : { status };
      });
    },
    /** Call only with a verified link ID; a row lock serializes consumption and revocation. */
    async markUsed(context: LinkScope) {
      return scope(context.gymId, async (tx) => {
        const [before] = await tx.select().from(signedLinks).where(and(
          eq(signedLinks.gymId, context.gymId), eq(signedLinks.id, context.linkId),
        )).for('update');
        if (!before || before.purpose === 'unsubscribe') missing();
        const status = state(before, clock.now());
        if (status !== 'active') throw new AppError('conflict', `Signed link is ${status}`);
        const now = clock.now();
        // Read time after acquiring the lock so a waiting request cannot use an expired link.
        if (before.expiresAt <= now) throw new AppError('conflict', 'Signed link is expired');
        const [row] = await tx.update(signedLinks).set({ usedAt: now }).where(and(
          eq(signedLinks.gymId, context.gymId), eq(signedLinks.id, context.linkId),
        )).returning();
        await audit(tx, { gymId: context.gymId, actor: { kind: 'system' } }, 'signed_link.used', row!, now, before);
        await completeCampaignIn(tx, context.gymId, before.campaignId, now);
        return metadata(row!);
      });
    },
    /**
     * One send command. Its generation is in the delivery key, so a retry finds the first attempt and a deliberate resend,
     * which has a new generation, sends again. The key's row is reserved and names the link in the transaction that
     * creates it, so a replay returns that link and no crash can leave a credential the key doesn't know.
     */
    async send(context: MutationContext, input: SendSignedLinkRequest) {
      assertNoTransaction('links.send');
      const { sendGeneration, channel = 'email', recipientMemberId, ...fields } = sendSignedLinkRequestSchema.parse(input);
      const sending = channel === 'sms' ? smsDeliveries : deliveries;
      const request = lowercaseIds(fields);
      const recipientId = recipientMemberId?.toLowerCase();
      const key = `links.${channel === 'sms' ? 'sms' : 'send'}.${request.purpose}:${request.householdId}:${sendGeneration.toLowerCase()}`;
      // The expiry isn't part of the request's identity: a client computes it afresh for each try.
      const digest = commandDigest([request.purpose === 'pay_invoice' ? request.invoiceId : null,
        request.purpose === 'sign_waiver' ? request.memberId : null, request.campaignId ?? null,
        ...(channel === 'sms' ? [recipientId ?? null] : [])]);
      const replayed = await scope(context.gymId, tx => sending.replay(tx, context.gymId, key, digest));
      if (replayed) return { ...await get(context.gymId, sentLinkSchema.parse(replayed.result).linkId), ...(replayed.outcome ? { outcome: replayed.outcome } : {}) };
      const gym = channel === 'sms' ? await settings.get(context.gymId) : undefined;
      // Refuse foreign or ineligible recipients even when this gym has no configured text transport.
      // Preparation can be slow; check again atomically with minting below.
      if (channel === 'sms') await scope(context.gymId, tx => signedLinkSmsRecipient(tx, context.gymId, request.householdId, recipientId, gym!.country, request.purpose));
      const delivery = options.delivery ?? configuredDelivery, smsDelivery = options.smsDelivery ?? configuredSmsDelivery;
      if (channel === 'email' && !delivery || channel === 'sms' && !smsDelivery)
        throw new AppError('unavailable', `Signed link ${channel === 'email' ? 'email' : 'text'} delivery is not configured`, { reason: ['delivery_unavailable'] });
      // A gym without SMTP refuses while preparing: name a reasonless unavailable there as unconfigured delivery.
      const prepare = async <T>(run: () => Promise<T>) => {
        try { return await run(); }
        catch (error) {
          if (error instanceof AppError && error.code === 'unavailable' && !error.details?.reason?.length)
            throw Object.assign(new AppError('unavailable', error.message, { reason: ['delivery_unavailable'] }), { cause: error });
          throw error;
        }
      };
      // SMS preparation never requires SMTP or the member-email switch.
      const prepared = channel === 'email' ? await prepare(() => delivery!.prepare(context.gymId)) : undefined;
      const preparedSms = channel === 'sms' ? await prepare(() => smsDelivery!.prepare(context.gymId)) : undefined;
      if (prepared) validateSignedLinkDelivery(prepared, context.gymId);
      if (preparedSms) validateSignedLinkOrigin(preparedSms, context.gymId);
      const { created, reservation, recipient } = await scope(context.gymId, async tx => {
        const recipient = channel === 'sms'
          ? await signedLinkSmsRecipient(tx, context.gymId, request.householdId, recipientId, gym!.country, request.purpose) : undefined;
        const reservation = await sending.reserve(tx, context.gymId, key, digest);
        // Check the invoice before minting. Manual notices keep a revoked metadata record
        // for the send response, but never commit an active undisclosed credential.
        let manualPayment = false;
        if (request.purpose === 'pay_invoice') {
          const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.gymId, context.gymId),
            eq(invoices.id, request.invoiceId), eq(invoices.householdId, request.householdId))).for('update');
          if (!invoice) missing();
          if (!['open', 'past_due'].includes(invoice.status)) throw new AppError('conflict', 'Invoice cannot be paid');
          if (invoice.amountCents === 0) throw new AppError('conflict', 'No payment is needed', { reason: ['zero_invoice'] });
          manualPayment = !!cardChargeIssue(invoice.amountCents, invoice.currency);
        }
        const created = (await createSignedLinksIn(tx, context, [request], clock.now()))[0]!;
        if (manualPayment) {
          created.link = await revokeSignedLinkIn(tx, context, created.link.id, clock.now());
        }
        await sending.remember(tx, reservation, { linkId: created.link.id });
        return { created, reservation, recipient };
      });
      // Observe the email boundary; SMS uses MemberSms for its last-moment checks.
      let entered = false, suppressed = false;
      const email: Email = { async sendEmail(message) {
        entered = true;
        const result = await deliveries.attempt(reservation, prepared!.email, message);
        suppressed = result.status !== 'sent';
        return result;
      } };
      let disclosed: boolean;
      // The link was never disclosed. Even if revocation fails, release this definite non-send for a safe retry.
      const cleanup = () => releaseUndisclosed([() => revoke(context, created.link.id)], () => sending.release(reservation),
        'Signed link cleanup failed');
      try {
        if (preparedSms && recipient) {
          const sms = new MemberSms({ gymId: context.gymId, memberIds: recipient.memberIds, householdIds: recipient.householdIds,
            kind: 'notices', resolver: householdBoundSmsResolver(preparedSms.resolver, scope, context.gymId, request.householdId, recipient.memberIds, request.purpose), settings, scope, clock });
          let manual = created.link.revokedAt !== null;
          if (request.purpose === 'pay_invoice') {
            const invoice = await scope(context.gymId, async tx => (await tx.select().from(invoices)
              .where(and(eq(invoices.id, request.invoiceId), eq(invoices.householdId, request.householdId))))[0]);
            if (!invoice || !['open', 'past_due'].includes(invoice.status) || invoice.amountCents === 0)
              throw new AppError('conflict', 'Invoice cannot be paid');
            manual ||= !!cardChargeIssue(invoice.amountCents, invoice.currency);
          }
          const body = manual ? preparedSms.t('links/service:manualPayment')
            : `${preparedSms.t(`links/service:${request.purpose}.subject`)}: ${new URL(`/l/${created.token}`, preparedSms.origin).href}`;
          entered = true;
          const result = await smsDeliveries.attempt(reservation, sms, { to: recipient.to, body });
          suppressed = result.status !== 'sent';
          // Only a missing consent is the recipient's; texting turned off or no provider is unconfigured delivery.
          if (result.status !== 'sent') throw new AppError('unavailable', 'Signed link text was suppressed', { reason: [
            result.reason === 'no_consent' ? 'recipient_suppressed_sms'
              : result.reason === 'disabled' || result.reason === 'no_provider' ? 'delivery_unavailable' : 'delivery_failed'] });
          disclosed = !manual;
        } else {
          disclosed = await deliverSignedLink({ scope, context, link: created.link, token: created.token, delivery: { ...prepared!, email },
            manualPayment: created.link.revokedAt !== null });
        }
      } catch (error) {
        // A definite non-send can't leave an undisclosed credential active, and a retry mints a new one. A possibly
        // delivered link stays usable: a replay returns it and never sends another.
        let cause = error;
        if (!entered || suppressed || deliveryAcceptance(error) === 'not_accepted') {
          try { await cleanup(); }
          catch (cleanupError) { cause = new AggregateError([error, cleanupError], 'Signed link delivery and cleanup failed'); }
        }
        if (error instanceof AppError && error.code === 'conflict' && !entered && cause === error) throw error;
        const firstReason = error instanceof AppError ? error.details?.reason?.[0] : undefined;
        const reason = firstReason && sendRefusalReasons.has(firstReason) ? firstReason : 'delivery_failed';
        throw Object.assign(new AppError('unavailable', `Signed link ${channel === 'email' ? 'email' : 'text'} was not delivered`, { reason: [reason] }), { cause });
      }
      // The message was delivered, so a failure here must not report otherwise.
      if (!disclosed) await revoke(context, created.link.id);
      return get(context.gymId, created.link.id);
    },
  };
}

let configuredDelivery: SignedLinkDelivery | undefined;
let configuredSmsDelivery: SignedLinkSmsDelivery | undefined;
/** Composition supplies a gym SMS resolver and trusted origin independently of SMTP. */
export function configureSignedLinkSmsDelivery(delivery: SignedLinkSmsDelivery): void { configuredSmsDelivery = delivery; }
/** Composition supplies the email transport and canonical per-gym origin, never the request Host header. */
export function configureSignedLinkDelivery(delivery: SignedLinkDelivery): void { configuredDelivery = delivery; }
