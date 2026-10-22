// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { and, count, desc, eq } from 'drizzle-orm';
import {
  forGym, households, invoices, linkCampaigns, members, signedLinks, writeAudit,
  type Transaction,
} from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import {
  createSignedLinkRequestSchema, signedLinkListQuerySchema, signedLinkSchema,
  type CreateSignedLinkRequest, type SignedLinkRecord, type SignedLinkListQuery,
} from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { deliverSignedLink, validateSignedLinkDelivery, type SignedLinkDelivery } from './service.delivery.js';

type LinkRow = typeof signedLinks.$inferSelect;
export type SignedLinkPrincipal = Extract<Principal, { kind: 'signed_link' }>;
export type SignedLinkResolution =
  | { readonly status: 'active'; readonly principal: SignedLinkPrincipal }
  | { readonly status: 'not_found' | 'expired' | 'used' | 'revoked' };
export interface LinkScope { readonly gymId: string; readonly linkId: string }

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
    : link.purpose === 'sign_waiver' ? { purpose: link.purpose, memberId: link.memberId }
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
async function audit(tx: Transaction, context: MutationContext, action: string, row: LinkRow, now: Date, before?: LinkRow) {
  await writeAudit(tx, {
    gymId: context.gymId, actorKind: context.actor.kind,
    ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
    action, targetType: 'signed_link', targetId: row.id, occurredAt: now,
    ...(before ? { before: metadata(before) } : {}), after: metadata(row),
  });
}

export function createSignedLinksService(options: {
  scope?: typeof forGym;
  clock?: Clock;
  delivery?: SignedLinkDelivery;
} = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  async function create(context: MutationContext, input: CreateSignedLinkRequest) {
    const request = createSignedLinkRequestSchema.parse(input);
    const token = randomBytes(32).toString('base64url');
    return scope(context.gymId, async (tx) => {
      const now = clock.now(), expiresAt = new Date(request.expiresAt);
      if (expiresAt <= now) throw new AppError('invalid_request', 'Signed link expiry must be in the future');
      const [household] = await tx.select({ id: households.id }).from(households).where(and(
        eq(households.gymId, context.gymId), eq(households.id, request.householdId),
      ));
      if (!household) missing();
      if (request.purpose === 'pay_invoice') {
        const [invoice] = await tx.select({ id: invoices.id }).from(invoices).where(and(
          eq(invoices.gymId, context.gymId), eq(invoices.householdId, request.householdId), eq(invoices.id, request.invoiceId),
        ));
        if (!invoice) missing();
      } else if (request.purpose === 'sign_waiver') {
        const [member] = await tx.select({ id: members.id }).from(members).where(and(
          eq(members.gymId, context.gymId), eq(members.householdId, request.householdId), eq(members.id, request.memberId),
        ));
        if (!member) missing();
      }
      if (request.campaignId) {
        const [campaign] = await tx.select({ purpose: linkCampaigns.purpose }).from(linkCampaigns).where(and(
          eq(linkCampaigns.gymId, context.gymId), eq(linkCampaigns.id, request.campaignId),
        ));
        if (!campaign) missing();
        if (campaign.purpose !== request.purpose) throw new AppError('invalid_request', 'Campaign purpose does not match');
      }
      const [row] = await tx.insert(signedLinks).values({
        gymId: context.gymId, householdId: request.householdId, purpose: request.purpose,
        tokenHash: digest(token), expiresAt, createdAt: now,
        invoiceId: request.purpose === 'pay_invoice' ? request.invoiceId : null,
        memberId: request.purpose === 'sign_waiver' ? request.memberId : null,
        campaignId: request.campaignId ?? null,
        createdBy: context.actor.kind === 'user' ? context.actor.userId : null,
      }).returning();
      await audit(tx, context, 'signed_link.created', row!, now);
      return { link: metadata(row!), token };
    });
  }
  async function get(gymId: string, linkId: string) {
    return scope(gymId, async (tx) => {
      const [row] = await tx.select().from(signedLinks).where(and(eq(signedLinks.gymId, gymId), eq(signedLinks.id, linkId)));
      if (!row) missing();
      return metadata(row);
    });
  }
  async function revoke(context: MutationContext, linkId: string) {
    return scope(context.gymId, async (tx) => {
      const [before] = await tx.select().from(signedLinks).where(and(
        eq(signedLinks.gymId, context.gymId), eq(signedLinks.id, linkId),
      )).for('update');
      if (!before) missing();
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
    create, get, revoke,
    async list(gymId: string, input: Partial<SignedLinkListQuery> = {}) {
      const query = signedLinkListQuerySchema.parse(input);
      return scope(gymId, async (tx) => {
        const filter = and(eq(signedLinks.gymId, gymId),
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
        if (!before) missing();
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
    async send(context: MutationContext, input: CreateSignedLinkRequest) {
      assertNoTransaction('links.send');
      const delivery = options.delivery ?? configuredDelivery;
      if (!delivery) throw new AppError('unavailable', 'Signed link email delivery is not configured');
      // Resolve the trusted origin and delivery preferences before minting a credential.
      const prepared = await delivery.prepare(context.gymId);
      validateSignedLinkDelivery(prepared, context.gymId);
      const created = await create(context, input);
      try {
        await deliverSignedLink({ scope, context, link: created.link, token: created.token, delivery: prepared });
      } catch {
        // A failed or suppressed send cannot leave an undisclosed credential active.
        await revoke(context, created.link.id);
        throw new AppError('unavailable', 'Signed link email was not delivered');
      }
      return get(context.gymId, created.link.id);
    },
  };
}

let configuredDelivery: SignedLinkDelivery | undefined;
/** Composition supplies the email transport and canonical per-gym origin, never the request Host header. */
export function configureSignedLinkDelivery(delivery: SignedLinkDelivery): void { configuredDelivery = delivery; }