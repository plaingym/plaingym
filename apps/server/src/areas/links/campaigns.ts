// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { auditEvents, forGym, linkCampaigns, signedLinks, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { addDays, localDate, zonedInstant } from '@plaingym/shared/time';
import { campaignRecipientListQuerySchema, createLinkCampaignRequestSchema, linkCampaignListQuerySchema,
  type CreateLinkCampaignRequest, type CreateSignedLinkRequest } from '@plaingym/shared/contracts';
import { z } from 'zod';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { JobRecovery, Jobs } from '../../infra/jobs/index.js';
import type { Payments } from '../../infra/payments/index.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createSignedLinksService } from './service.js';
import type { SignedLinkDelivery } from './service.delivery.js';
import { campaignDetail, campaignRecipient } from './campaigns.model.js';
import { deliverCampaignLink } from './campaigns.delivery.js';
import { matchCampaignCustomer } from './campaigns.customers.js';
import { checkoutInProgress, deliveryBlocked, deliveryHistory } from './campaigns.attempts.js';

export const campaignSendJob = 'links.campaigns.send';
export const campaignPublishJob = 'links.campaigns.publish';
export interface CampaignsOptions {
  scope?: typeof forGym;
  clock?: Clock;
  jobs: Jobs & JobRecovery;
  delivery: SignedLinkDelivery;
  paymentsFor(gymId: string): Promise<Payments>;
}
const payloadSchema = z.strictObject({ campaignId: z.uuid(), linkId: z.uuid(), occurrence: z.string().min(1).max(80) });
const missing = (): never => { throw new AppError('not_found', 'Campaign not found'); };
function occurrenceAt(campaign: { createdAt: Date; reminderSchedule: unknown }, now: Date, timezone: string) {
  let occurrence = 'initial';
  for (const day of campaign.reminderSchedule as number[]) {
    let due: Date;
    try { due = zonedInstant(addDays(localDate(campaign.createdAt, timezone), day), '09:00', timezone, { gap: 'shift' })!; }
    catch (error) { if (error instanceof RangeError) break; throw error; }
    if (due <= now) occurrence = 'day:' + day;
    else break;
  }
  return occurrence;
}

export function createCampaignsService(options: CampaignsOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const settings = createGymSettingsAccessor({ scope });
  async function get(gymId: string, campaignId: string) {
    return scope(gymId, async tx => {
      const [row] = await tx.select().from(linkCampaigns).where(eq(linkCampaigns.id, campaignId));
      if (!row) return missing();
      const links = await tx.select().from(signedLinks).where(eq(signedLinks.campaignId, campaignId));
      return campaignDetail(row, links.map(link => campaignRecipient(link, clock.now())));
    });
  }
  /** Retries published, unreserved sends whose jobs used up their attempts, at most once per gym-local day. */
  async function retryExhausted(gymId: string, timezone: string, campaignId: string, occurrence: string, linkIds: string[]) {
    const now = clock.now(), today = localDate(now, timezone);
    const keys = new Map(linkIds.map(id => [`${id}:${occurrence}`, id]));
    // Like scheduled reminders, a retry goes out from 09:00 gym-local.
    const runAt = new Date(Math.max(now.getTime(), zonedInstant(today, '09:00', timezone, { gap: 'shift' })!.getTime()));
    for (const job of await options.jobs.failedJobs(campaignSendJob, [...keys.keys()], { gymId })) {
      if (localDate(job.failedAt, timezone) >= today) continue;
      if (await options.jobs.retryFailed(job.jobId, { gymId, runAt })) await scope(gymId, tx => writeAudit(tx, { gymId,
        actorKind: 'system', action: 'link_campaign.delivery_retried', targetType: 'signed_link', targetId: keys.get(job.idempotencyKey)!,
        after: { campaignId, occurrence }, occurredAt: now }));
    }
  }
  async function queue(gymId: string, campaignId: string, occurrence: string, retry = false) {
    const gym = await settings.get(gymId);
    if (!gym.memberEmailsEnabled) return 0;
    const rows = await scope(gymId, tx => tx.select({ id: signedLinks.id }).from(signedLinks).where(and(
      eq(signedLinks.gymId, gymId), eq(signedLinks.campaignId, campaignId), isNull(signedLinks.usedAt),
      isNull(signedLinks.revokedAt), gt(signedLinks.expiresAt, clock.now()))).orderBy(asc(signedLinks.id)));
    if (!rows.length) return 0;
    const history = await scope(gymId, tx => deliveryHistory(tx, gymId, rows.map(r => r.id)));
    let queued = 0;
    for (let offset = 0; offset < rows.length; offset += 100) {
      const audits: (typeof auditEvents.$inferInsert)[] = [], published: string[] = [];
      for (const row of rows.slice(offset, offset + 100)) {
        if (deliveryBlocked(history, row.id, occurrence, clock.now(), gym.timezone, true)) {
          // Published but never reserved: its send job may have failed before reaching delivery.
          if (retry && !deliveryBlocked(history, row.id, occurrence, clock.now(), gym.timezone)) published.push(row.id);
          continue;
        }
        await options.jobs.enqueue(campaignSendJob, { campaignId, linkId: row.id, occurrence }, {
          gymId, timezone: gym.timezone, idempotencyKey: `${row.id}:${occurrence}`, maxAttempts: 8,
        });
        audits.push({ gymId, actorKind: 'system', action: 'link_campaign.delivery_queued',
          targetType: 'signed_link', targetId: row.id, after: { campaignId, occurrence }, occurredAt: clock.now() });
        queued++;
      }
      // A crash before the batch commits is repaired using the same recipient job keys.
      if (audits.length) await scope(gymId, tx => tx.insert(auditEvents).values(audits));
      if (published.length) await retryExhausted(gymId, gym.timezone, campaignId, occurrence, published);
    }
    return queued;
  }
  return {
    get,
    async publish(payload: unknown, gymId: string) {
      const { campaignId } = z.strictObject({ campaignId: z.uuid() }).parse(payload);
      await queue(gymId, campaignId, 'initial');
    },
    async create(context: MutationContext, input: CreateLinkCampaignRequest) {
      const request = createLinkCampaignRequestSchema.parse(input);
      // TODO: mirror these bounds in the shared campaign contract.
      if (request.name.length > 120 || request.recipients.length > 2000 || request.reminderSchedule.length > 10
        || request.reminderSchedule.some(day => day > 365)
        || new Date(request.expiresAt).getTime() > clock.now().getTime() + 90 * 86400000)
        throw new AppError('invalid_request', 'Campaign limits: 120-character name, 2000 recipients, 10 reminder days up to 365, and expiry within 90 days');
      // The campaign and its recipient set are one atomic definition. External work is per-link in jobs.
      const id = await scope(context.gymId, async tx => {
        const [row] = await tx.insert(linkCampaigns).values({ gymId: context.gymId, name: request.name,
          purpose: request.purpose, reminderSchedule: request.reminderSchedule, createdAt: clock.now(),
          createdBy: context.actor.kind === 'user' ? context.actor.userId : null }).returning();
        // Reuse the signed-link service's resource validation and auditing inside this existing transaction.
        const links = createSignedLinksService({ clock, scope: async (gymId, fn) => {
          if (gymId !== context.gymId) throw new Error('Campaign scope mismatch');
          return fn(tx);
        } });
        for (const recipient of request.recipients) {
          const link = { purpose: request.purpose, expiresAt: request.expiresAt, campaignId: row!.id,
            ...recipient } as CreateSignedLinkRequest;
          await links.create(context, link);
        }
        await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
          ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
          action: 'link_campaign.created', targetType: 'link_campaign', targetId: row!.id,
          after: { purpose: request.purpose, recipients: request.recipients.length, reminderSchedule: request.reminderSchedule }, occurredAt: clock.now() });
        return row!.id;
      });
      try {
        const gym = await settings.get(context.gymId);
        await options.jobs.enqueue(campaignPublishJob, { campaignId: id }, {
          gymId: context.gymId, timezone: gym.timezone, idempotencyKey: `${id}:initial`, maxAttempts: 8,
        });
      }
      catch {
        // The definition is committed. Return it so the client does not duplicate it; the hourly scan repairs publication.
        await scope(context.gymId, tx => writeAudit(tx, { gymId: context.gymId, actorKind: 'system',
          action: 'link_campaign.enqueue_failed', targetType: 'link_campaign', targetId: id, occurredAt: clock.now() }));
      }
      return get(context.gymId, id);
    },
    async list(gymId: string, input: z.input<typeof linkCampaignListQuerySchema> = {}) {
      const query = linkCampaignListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        const filter = query.purpose ? eq(linkCampaigns.purpose, query.purpose) : undefined;
        const [total] = await tx.select({ value: count() }).from(linkCampaigns).where(filter);
        const rows = await tx.select().from(linkCampaigns).where(filter).orderBy(desc(linkCampaigns.createdAt), desc(linkCampaigns.id))
          .limit(query.limit).offset(query.offset);
        const links = rows.length ? await tx.select().from(signedLinks).where(inArray(signedLinks.campaignId, rows.map(r => r.id))) : [];
        return { data: rows.map(row => campaignDetail(row, links.filter(l => l.campaignId === row.id).map(l => campaignRecipient(l, clock.now())))),
          pagination: { total: total!.value, limit: query.limit, offset: query.offset } };
      });
    },
    async recipients(gymId: string, campaignId: string, input: z.input<typeof campaignRecipientListQuerySchema> = {}) {
      const query = campaignRecipientListQuerySchema.parse(input);
      await get(gymId, campaignId);
      const rows = await scope(gymId, tx => tx.select().from(signedLinks).where(eq(signedLinks.campaignId, campaignId)).orderBy(asc(signedLinks.id)));
      const recipients = rows.map(r => campaignRecipient(r, clock.now())).filter(r => !query.state || r.state === query.state);
      return { data: recipients.slice(query.offset, query.offset + query.limit),
        pagination: { total: recipients.length, limit: query.limit, offset: query.offset } };
    },
    async remindCampaign(context: MutationContext, campaignId: string) {
      await get(context.gymId, campaignId);
      const gym = await settings.get(context.gymId);
      const occurrence = 'manual:' + localDate(clock.now(), gym.timezone);
      const queued = await queue(context.gymId, campaignId, occurrence);
      await scope(context.gymId, tx => writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
        ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
        action: 'link_campaign.reminded', targetType: 'link_campaign', targetId: campaignId,
        after: { queued, occurrence }, occurredAt: clock.now() }));
      return { queued };
    },
    async scan(gymId: string) {
      const gym = await settings.get(gymId);
      if (!gym.memberEmailsEnabled) return;
      let cursor: string | undefined;
      for (;;) {
        const rows = await scope(gymId, tx => tx.select({ id: linkCampaigns.id, createdAt: linkCampaigns.createdAt,
          reminderSchedule: linkCampaigns.reminderSchedule }).from(linkCampaigns)
          .innerJoin(signedLinks, and(eq(signedLinks.gymId, gymId), eq(signedLinks.campaignId, linkCampaigns.id)))
          .where(and(eq(linkCampaigns.gymId, gymId), isNull(signedLinks.usedAt), isNull(signedLinks.revokedAt),
            gt(signedLinks.expiresAt, clock.now()), cursor ? gt(linkCampaigns.id, cursor) : undefined))
          .groupBy(linkCampaigns.id).orderBy(asc(linkCampaigns.id)).limit(100));
        for (const row of rows) {
          // Catch up only the latest due reminder, avoiding a burst after downtime. All days use local 09:00.
          await queue(gymId, row.id, occurrenceAt(row, clock.now(), gym.timezone), true);
        }
        if (rows.length < 100) return;
        cursor = rows.at(-1)!.id;
      }
    },
    async send(payload: unknown, gymId: string) {
      const work = payloadSchema.parse(payload);
      const gym = await settings.get(gymId);
      const [row] = await scope(gymId, tx => tx.select().from(signedLinks).where(and(
        eq(signedLinks.id, work.linkId), eq(signedLinks.campaignId, work.campaignId))));
      if (!row || campaignRecipient(row, clock.now()).state !== 'pending') return;
      if (!gym.memberEmailsEnabled) {
        await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'link_campaign.delivery_skipped',
          targetType: 'signed_link', targetId: row.id, after: { campaignId: work.campaignId, occurrence: work.occurrence,
            reason: 'member_emails_disabled' }, occurredAt: clock.now() }));
        return;
      }
      const history = await scope(gymId, tx => deliveryHistory(tx, gymId, [row.id]));
      if (checkoutInProgress(history, row.id, clock.now())) {
        await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'link_campaign.delivery_deferred',
          targetType: 'signed_link', targetId: row.id, after: { campaignId: work.campaignId, occurrence: work.occurrence }, occurredAt: clock.now() }));
        return;
      }
      if (deliveryBlocked(history, row.id, work.occurrence, clock.now(), gym.timezone)) return;
      if (!work.occurrence.startsWith('manual:')) {
        const [campaign] = await scope(gymId, tx => tx.select().from(linkCampaigns).where(eq(linkCampaigns.id, work.campaignId)));
        if (!campaign || occurrenceAt(campaign, clock.now(), gym.timezone) !== work.occurrence) return;
      }
      if (row.purpose !== 'sign_waiver') {
        try { await matchCampaignCustomer({ scope, clock, paymentsFor: options.paymentsFor }, gymId, row.householdId); }
        catch {
          await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'link_campaign.customer_match_failed',
            targetType: 'signed_link', targetId: row.id, after: { campaignId: work.campaignId, occurrence: work.occurrence }, occurredAt: clock.now() }));
        }
      }
      await deliverCampaignLink({ scope, clock, delivery: options.delivery }, gymId, work.campaignId, work.linkId, work.occurrence);
    },
  };
}
export type CampaignsService = ReturnType<typeof createCampaignsService>;
let configured: CampaignsService | undefined;
export function configureCampaigns(service: CampaignsService) { configured = service; }
export function campaignService() {
  if (!configured) throw new AppError('unavailable', 'Campaign delivery is not configured');
  return configured;
}
