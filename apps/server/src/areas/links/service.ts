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
  createSignedLinkRequestSchema, idSchema, sendSignedLinkRequestSchema, signedLinkListQuerySchema, signedLinkSchema,
  type CreateSignedLinkRequest, type SendSignedLinkRequest, type SignedLinkRecord, type SignedLinkListQuery,
} from '@plaingym/shared/contracts';
import { z } from 'zod';
import { clock as defaultClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { commandDigest, createEmailDeliveries, deliveryAcceptance, type Email } from '../../infra/email/index.js';
import { deliverSignedLink, validateSignedLinkDelivery, type SignedLinkDelivery } from './service.delivery.js';

type LinkRow = typeof signedLinks.$inferSelect;
export type SignedLinkPrincipal = Extract<Principal, { kind: 'signed_link' }>;
export type SignedLinkResolution =
  | { readonly status: 'active'; readonly principal: SignedLinkPrincipal }
  | { readonly status: 'not_found' | 'expired' | 'used' | 'revoked' };
export interface LinkScope { readonly gymId: string; readonly linkId: string }
/** What a send command remembers for its replay. */
const sentLinkSchema = z.strictObject({ linkId: idSchema });

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
async function checkResources(tx: Transaction, gymId: string, all: CreateSignedLinkRequest[], now: Date) {
  const expired = all.findIndex(request => new Date(request.expiresAt) <= now);
  const requests = expired < 0 ? all : all.slice(0, expired);
  const householdIds = new Set((await lookup(requests.map(r => r.householdId), ids => tx.select({ id: households.id })
    .from(households).where(and(eq(households.gymId, gymId), inArray(households.id, ids))))).map(row => row.id));
  const invoiceHouseholds = new Map((await lookup(requests.flatMap(r => r.purpose === 'pay_invoice' ? [r.invoiceId] : []),
    ids => tx.select({ id: invoices.id, householdId: invoices.householdId }).from(invoices)
      .where(and(eq(invoices.gymId, gymId), inArray(invoices.id, ids))))).map(row => [row.id, row.householdId]));
  const waiverMembers = new Map((await lookup(requests.flatMap(r => r.purpose === 'sign_waiver' ? [r.memberId] : []),
    ids => tx.select({ id: members.id, householdId: members.householdId, anonymizedAt: members.anonymizedAt }).from(members)
      .where(and(eq(members.gymId, gymId), inArray(members.id, ids))).orderBy(asc(members.id)).for('update'))).map(row => [row.id, row]));
  const campaignPurposes = new Map((await lookup(requests.flatMap(r => r.campaignId ? [r.campaignId] : []),
    ids => tx.select({ id: linkCampaigns.id, purpose: linkCampaigns.purpose }).from(linkCampaigns)
      .where(and(eq(linkCampaigns.gymId, gymId), inArray(linkCampaigns.id, ids))))).map(row => [row.id, row.purpose]));
  for (const request of requests) {
    if (!householdIds.has(request.householdId)) missing();
    if (request.purpose === 'pay_invoice') {
      if (invoiceHouseholds.get(request.invoiceId) !== request.householdId) missing();
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
export async function createSignedLinksIn(tx: Transaction, context: MutationContext, inputs: CreateSignedLinkRequest[], now: Date) {
  const requests = inputs.map(input => lowercaseIds(createSignedLinkRequestSchema.parse(input)));
  const seen = new Set<string>();
  for (const request of requests) {
    const kind = request.purpose === 'pay_invoice' ? 'invoice' : request.purpose === 'sign_waiver' ? 'member' : 'household';
    const id = request.purpose === 'pay_invoice' ? request.invoiceId : request.purpose === 'sign_waiver' ? request.memberId : request.householdId;
    const key = `${request.purpose}:${id}`;
    if (seen.has(key)) throw new AppError('invalid_request', `${kind === 'invoice' ? 'An' : 'A'} ${kind} may appear only once`);
    seen.add(key);
  }
  await checkResources(tx, context.gymId, requests, now);
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
  return created;
}

export function createSignedLinksService(options: {
  scope?: typeof forGym;
  clock?: Clock;
  delivery?: SignedLinkDelivery;
} = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const deliveries = createEmailDeliveries({ scope, clock });
  /** Creates every link or none, in one transaction (`createSignedLinksIn`). */
  async function createMany(context: MutationContext, inputs: CreateSignedLinkRequest[]) {
    return scope(context.gymId, tx => createSignedLinksIn(tx, context, inputs, clock.now()));
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
    return scope(context.gymId, async (tx) => {
      const [before] = await tx.select().from(signedLinks).where(and(
        eq(signedLinks.gymId, context.gymId), eq(signedLinks.id, linkId),
      )).for('update');
      if (!before || before.purpose === 'unsubscribe') missing();
      if (before.revokedAt !== null) return metadata(before);
      const now = clock.now();
      const [row] = await tx.update(signedLinks).set({ revokedAt: now }).where(and(
        eq(signedLinks.gymId, context.gymId), eq(signedLinks.id, linkId),
      )).returning();
      await audit(tx, context, 'signed_link.revoked', row!, now, before);
      return metadata(row!);
    });
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
    async resolve(gymId: string, token: string): Promise<SignedLinkResolution> {
      // Avoid unbounded hashing and never reveal whether a malformed credential has a row.
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) return { status: 'not_found' };
      return scope(gymId, async (tx) => {
        const [row] = await tx.select().from(signedLinks).where(and(
          eq(signedLinks.gymId, gymId), eq(signedLinks.tokenHash, digest(token)),
        ));
        if (!row) return { status: 'not_found' };
        const status = state(row, clock.now());
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
      const delivery = options.delivery ?? configuredDelivery;
      if (!delivery) throw new AppError('unavailable', 'Signed link email delivery is not configured');
      // Resolve the trusted origin and delivery preferences before minting a credential.
      const prepared = await delivery.prepare(context.gymId);
      validateSignedLinkDelivery(prepared, context.gymId);
      const { sendGeneration, ...fields } = sendSignedLinkRequestSchema.parse(input);
      const request = lowercaseIds(fields);
      const key = `links.send.${request.purpose}:${request.householdId}:${sendGeneration.toLowerCase()}`;
      // The expiry isn't part of the request's identity: a client computes it afresh for each try.
      const digest = commandDigest([request.purpose === 'pay_invoice' ? request.invoiceId : null,
        request.purpose === 'sign_waiver' ? request.memberId : null, request.campaignId ?? null]);
      const replayed = await scope(context.gymId, tx => deliveries.replay(tx, context.gymId, key, digest));
      if (replayed) return get(context.gymId, sentLinkSchema.parse(replayed.result).linkId);
      const { created, reservation } = await scope(context.gymId, async tx => {
        const reservation = await deliveries.reserve(tx, context.gymId, key, digest);
        // Check the invoice before minting. Manual notices keep a revoked metadata record
        // for the send response, but never commit an active undisclosed credential.
        let manualPayment = false;
        if (request.purpose === 'pay_invoice') {
          const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.gymId, context.gymId),
            eq(invoices.id, request.invoiceId), eq(invoices.householdId, request.householdId))).for('update');
          if (!invoice) missing();
          if (invoice.amountCents === 0) throw new AppError('conflict', 'This invoice settles on its due date', { reason: ['zero_invoice'] });
          manualPayment = !!cardChargeIssue(invoice.amountCents, invoice.currency);
        }
        const created = (await createSignedLinksIn(tx, context, [request], clock.now()))[0]!;
        if (manualPayment) {
          const now = clock.now();
          const [before] = await tx.select().from(signedLinks).where(eq(signedLinks.id, created.link.id));
          const [row] = await tx.update(signedLinks).set({ revokedAt: now }).where(eq(signedLinks.id, created.link.id)).returning();
          await audit(tx, context, 'signed_link.revoked', row!, now, before);
          created.link = metadata(row!);
        }
        await deliveries.remember(tx, reservation, { linkId: created.link.id });
        return { created, reservation };
      });
      // All sending and its last-moment checks stay in service.delivery; this records what reached the transport.
      let entered = false, suppressed = false;
      const email: Email = { async sendEmail(message) {
        entered = true;
        const result = await deliveries.attempt(reservation, prepared.email, message);
        suppressed = result.status !== 'sent';
        return result;
      } };
      let disclosed: boolean;
      try {
        disclosed = await deliverSignedLink({ scope, context, link: created.link, token: created.token, delivery: { ...prepared, email },
          manualPayment: created.link.revokedAt !== null });
      } catch (error) {
        if (!entered) await deliveries.release(reservation);
        // A definite non-send can't leave an undisclosed credential active, and a retry mints a new one. A possibly
        // delivered link stays usable: a replay returns it and never sends another.
        if (!entered || suppressed || deliveryAcceptance(error) === 'not_accepted') await revoke(context, created.link.id);
        throw new AppError('unavailable', 'Signed link email was not delivered');
      }
      // The email was delivered, so a failure here must not report otherwise.
      if (!disclosed) await revoke(context, created.link.id);
      return get(context.gymId, created.link.id);
    },
  };
}

let configuredDelivery: SignedLinkDelivery | undefined;
/** Composition supplies the email transport and canonical per-gym origin, never the request Host header. */
export function configureSignedLinkDelivery(delivery: SignedLinkDelivery): void { configuredDelivery = delivery; }
