// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, or } from 'drizzle-orm';
import { auditEvents, classSessions, emailDeliveries, forGym, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { cancellationNoticeChannelsSchema, idSchema } from '@plaingym/shared/contracts';
import { z } from 'zod';
import { clock as systemClock } from '../../core/clock.js';
import { logInfo } from '../../core/log.js';
import { createEmailDeliveries, DeliveryError, deliveryAcceptance, type Email } from '../../infra/email/index.js';
import { commandDigest, emailInFlightMs } from '../../infra/email/deliveries.js';
import { logEmailSuppression } from '../../infra/email/member.js';
import type { Jobs, JobTransaction } from '../../infra/jobs/index.js';
import { createGymSettingsAccessor, createSettingsService } from '../settings/settings.js';
import { renderCancellationNotice } from '../../emails/announcements/cancellation.js';
import { readAddressGroup } from './audience.js';
import { cancellationDecisionMemberId } from './cancellation.sql.js';
import { readMemberNoticeEmails } from '../bookings/bookings.recipients.js';
import { createCancellationSms, noticeScope } from './cancellation.sms.js';
import type { ClassNoticeSmsOptions } from '../bookings/bookings.sms.js';

export { noticeScope };
export const cancellationNoticeJob = 'announcements.cancellation';
/** `round` is the session's restore count when it was cancelled; a payload without it is round 0. */
const noticeFields = { sessionId: idSchema, memberIds: z.array(idSchema), note: z.string().max(1_000),
  round: z.number().int().positive().optional() };
/** One session's notice. Without `channels` it goes by email and text, as it did before staff could choose. */
export const cancellationNoticePayload = z.object({ ...noticeFields, channels: cancellationNoticeChannelsSchema.optional() });
type Notice = z.infer<typeof cancellationNoticePayload>;
// Stored payloads tolerate additional keys when a release rolls back. A notice for both channels keeps the flat
// shape that every release sends by both. A notice for one channel nests its fields under `notice`: a previous
// release requires a top-level `sessionId`, so it refuses that job before reserving anything instead of dropping
// `channels` and sending both. The job fails there, and announcement recovery retries it on a release that reads it.
const storedNotice = z.union([
  z.object({ channels: cancellationNoticeChannelsSchema, notice: z.object(noticeFields) })
    .transform(({ channels, notice }) => ({ ...notice, channels })),
  cancellationNoticePayload,
]);
/** The job payload stored for a notice. */
export function cancellationNoticeJobPayload(notice: Notice) {
  const { channels, ...fields } = cancellationNoticePayload.parse(notice);
  return channels?.length === 1 ? { channels, notice: fields } : fields;
}
const sends = (notice: Notice, channel: 'email' | 'sms') => !notice.channels || notice.channels.includes(channel);
export interface CancellationNoticeOptions {
  scope?: typeof forGym; clock?: Clock; jobs: Jobs;
  /** The gym's SMTP resolver, or the demo outbox when demo mode is enabled. */
  mailer(gymId: string): Promise<Email | null>;
  origin(gymId: string): Promise<string>;
  demoMode?: boolean;
  demoEmailFor?(gymId: string): Email;
  sms?: ClassNoticeSmsOptions;
}
/** One session's cancellation notice to one address group is keyed `<prefix><notice scope>:<first member's ID>`. */
export const cancellationNoticeKeyPrefix = 'schedule-cancel-notice:';
const noticeKey = (scoped: string, memberId: string) => `${cancellationNoticeKeyPrefix}${scoped}:${memberId}`;
const roundOf = (notice: Pick<Notice, 'round'>) => notice.round ?? 0;

export function createCancellationNotice(options: CancellationNoticeOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? systemClock;
  const settings = createGymSettingsAccessor({ scope }), details = createSettingsService({ scope });
  const deliveries = createEmailDeliveries({ scope, clock });
  const demo = options.demoMode ?? process.env.DEMO_MODE === 'true';
  const sms = createCancellationSms({ scope, clock, settings, ...(options.sms ? { sms: options.sms } : {}) });

  async function group(tx: Transaction, gymId: string, address: string, ids: readonly string[]) {
    // Inspect the whole address, including members outside this session. A global email preference or an
    // undeliverable address blocks it; announcement-only preferences never affect booking notices.
    const rows = await readAddressGroup(tx, address);
    const blocked = rows.some(row => row.emailOptOut) ? 'opt_out' as const
      : rows.some(row => !row.emailDeliverable) ? 'undeliverable' as const : null;
    if (blocked) return { rows: [], blocked };
    // Membership is bounded by the job-start candidates, including for direct addresses.
    return { rows: (await readMemberNoticeEmails(tx, gymId, [...new Set(ids)])).filter(row => row.address === address), blocked };
  }
  async function reserve(gymId: string, notice: Notice, address: string, ids: readonly string[]) {
    return scope(gymId, async tx => {
      // Only reservations are serialized: SMTP always runs after this transaction commits.
      const [session] = await tx.select().from(classSessions).where(eq(classSessions.id, notice.sessionId)).for('update');
      // A notice from before a restore never sends after it, even when the session is cancelled again.
      if (!session || session.status !== 'cancelled' || session.restoreCount !== roundOf(notice)) return;
      const { rows: current } = await group(tx, gymId, address, ids);
      if (!current.length) return;
      const scoped = noticeScope(notice.sessionId, notice.round);
      const key = noticeKey(scoped, current[0]!.id), digest = commandDigest([scoped, address]);
      // Both stable member keys and destination digests survive retries and address changes/convergence.
      const previous = await tx.select().from(emailDeliveries)
        .where(and(eq(emailDeliveries.gymId, gymId), or(eq(emailDeliveries.key, key), eq(emailDeliveries.commandDigest, digest))));
      if (previous.some(row => row.state === 'sending' && row.updatedAt.getTime() > clock.now().getTime() - emailInFlightMs))
        throw new AppError('conflict', 'Cancellation notice is in flight');
      if (previous.length) {
        // Any stored outcome can precede a crash before its audit. Recover the original member's decision without resending.
        const prefix = `${cancellationNoticeKeyPrefix}${scoped}:`;
        const recoverable = previous.flatMap(row => {
          if (!row.key.startsWith(prefix)) return [];
          const memberId = idSchema.safeParse(row.key.slice(prefix.length));
          return memberId.success ? [{ memberId: memberId.data, state: row.state }] : [];
        });
        if (recoverable.length) {
          const decisions = await tx.select({ memberId: cancellationDecisionMemberId, after: auditEvents.after }).from(auditEvents).where(and(
            eq(auditEvents.gymId, gymId), eq(auditEvents.targetId, notice.sessionId),
            eq(auditEvents.action, 'schedule.cancellation_notice_decided'),
            inArray(cancellationDecisionMemberId, recoverable.map(row => row.memberId))));
          // A decision from an earlier cancellation round doesn't cover this round; a missing round is round 0.
          const decided = new Set(decisions
            .filter(row => ((row.after as { round?: number } | null)?.round ?? 0) === roundOf(notice)).map(row => row.memberId));
          for (const row of recoverable) {
            if (decided.has(row.memberId)) continue;
            await decide(tx, gymId, notice, row.memberId, row.state === 'accepted' ? { status: 'sent' }
              : { status: 'failed', reason: row.state === 'not_accepted' ? 'not_accepted' : 'unknown' });
            decided.add(row.memberId);
          }
        }
        return;
      }
      const reserved = await deliveries.reserve(tx, gymId, key, digest);
      return { reserved, session, current };
    });
  }
  function decide(tx: Transaction, gymId: string, notice: Pick<Notice, 'sessionId' | 'round'>, memberId: string,
    outcome: { status: 'sent' | 'suppressed' | 'failed'; reason?: string }) {
    return writeAudit(tx, { gymId, actorKind: 'system', action: 'schedule.cancellation_notice_decided',
      targetType: 'class_session', targetId: notice.sessionId,
      after: { memberId, ...outcome, ...(notice.round ? { round: notice.round } : {}) }, occurredAt: clock.now() });
  }
  async function sendEmail(notice: Notice, gymId: string) {
    const gym = await settings.get(gymId);
    if (!gym.memberEmailsEnabled) return;
    const candidates = new Map<string, string[]>();
    // Bound query parameter counts even for a large roster. Only the cancellation's snapshot may receive mail.
    for (let offset = 0; offset < notice.memberIds.length; offset += 100) {
      const rows = await scope(gymId, tx => readMemberNoticeEmails(tx, gymId, notice.memberIds.slice(offset, offset + 100)));
      for (const { address, id } of rows) {
        const ids = candidates.get(address);
        if (ids) ids.push(id);
        else candidates.set(address, [id]);
      }
    }
    if (!candidates.size) return;
    const origin = new URL(await options.origin(gymId));
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
      throw new AppError('unavailable', 'Cancellation notices require a canonical HTTPS origin');
    if (demo && !options.demoEmailFor) throw new AppError('unavailable', 'Cancellation demo outbox is not configured');
    const email = demo ? options.demoEmailFor!(gymId) : await options.mailer(gymId);
    if (!email) throw new AppError('unavailable', 'Cancellation mail is not configured');
    const gymName = (await details.get(gymId)).name;
    let deferred = false;
    for (const [address, ids] of candidates) {
      let reservation: Awaited<ReturnType<typeof reserve>>;
      try { reservation = await reserve(gymId, notice, address, ids); }
      catch (error) { if (error instanceof AppError && error.code === 'conflict') { deferred = true; continue; } throw error; }
      if (!reservation) continue;
      const { reserved, session } = reservation;
      let outcome: { status: 'sent' | 'suppressed' | 'failed'; reason?: string };
      try {
        // Reload the group at the last boundary so an erasure or address change cannot disclose another member's name.
        const guarded: Email = { async sendEmail() {
          let current: Awaited<ReturnType<typeof group>>['rows'], latest: Awaited<ReturnType<typeof renderCancellationNotice>>;
          const memberId = reservation.current[0]!.id;
          try {
            if (!(await settings.get(gymId)).memberEmailsEnabled) {
              logEmailSuppression({ event: 'email.suppressed', gymId, memberId, reason: 'disabled' });
              return { status: 'suppressed', reason: 'disabled' };
            }
            const checked = await scope(gymId, async tx => {
              const [state] = await tx.select({ status: classSessions.status, restoreCount: classSessions.restoreCount })
                .from(classSessions).where(eq(classSessions.id, notice.sessionId));
              return state?.status === 'cancelled' && state.restoreCount === roundOf(notice) ? group(tx, gymId, address, ids) : undefined;
            });
            if (!checked) {
              // Restored since the reservation: this cancellation no longer holds, so nothing is said.
              logInfo('announcements.cancellation_notice_skipped', { gymId, sessionId: notice.sessionId, memberId, reason: 'restored' });
              return { status: 'suppressed', reason: 'opt_out' };
            }
            current = checked.rows;
            if (!current.length) {
              if (checked.blocked) {
                logEmailSuppression({ event: 'email.suppressed', gymId, memberId, reason: checked.blocked });
                return { status: 'suppressed', reason: checked.blocked };
              }
              // Nobody covered is left at the address (erased, or moved): no preference blocked it, so no suppression is
              // logged. The result type has no reason for this, and nothing stores the returned one.
              logInfo('announcements.cancellation_notice_skipped', { gymId, sessionId: notice.sessionId, memberId, reason: 'no_recipient' });
              return { status: 'suppressed', reason: 'opt_out' };
            }
            // A member at their own address isn't told their own name; a household address still lists who it covers.
            const showMembers = current.length !== 1 || !current[0]!.email;
            latest = await renderCancellationNotice({ gymName, name: session.name, startsAt: session.startsAt, timezone: gym.timezone,
              memberNames: current.map(row => `${row.firstName} ${row.lastName}`), showMembers, note: notice.note,
              scheduleUrl: new URL('/portal/schedule', origin).href });
          } catch (cause) { throw new DeliveryError('not_accepted', 'Cancellation notice could not be prepared', { cause }); }
          // The group guard also authorizes billing addresses for members with no email of their own.
          return email.sendEmail({ to: address, ...latest });
        } };
        // The guard builds the final content exactly once, after its last address read.
        const result = await deliveries.attempt(reserved, guarded, { to: address, subject: session.name, text: notice.note, html: '' });
        outcome = { status: result.status };
      } catch (error) {
        // This address is decided, including an uncertain acceptance. A failed address must not strand the rest.
        outcome = { status: 'failed', reason: deliveryAcceptance(error) };
      }
      await scope(gymId, tx => decide(tx, gymId, notice, reservation.current[0]!.id, outcome));
    }
    if (deferred) throw new AppError('conflict', 'Cancellation notice is in flight');
  }
  return {
    async enqueue(transaction: JobTransaction, payload: Notice, timezone: string) {
      const notice = cancellationNoticePayload.parse(payload);
      await options.jobs.enqueue(cancellationNoticeJob, cancellationNoticeJobPayload(notice), { gymId: transaction.gymId, timezone,
        idempotencyKey: `schedule-cancel-notice:${noticeScope(notice.sessionId, notice.round)}`, maxAttempts: 12 }, transaction);
    },
    async run(payload: unknown, gymId: string) {
      const notice = storedNotice.parse(payload);
      // An email's failure, suppression or earlier acceptance cannot prevent the independent SMS attempt.
      // When both channels fail, the email's error is reported; the text's never hides it.
      // A channel staff didn't choose is never reserved or attempted.
      let failure: unknown;
      if (sends(notice, 'email')) try { await sendEmail(notice, gymId); } catch (error) { failure = error; }
      if (sends(notice, 'sms')) try { await sms.run(notice, gymId); } catch (error) { failure ??= error; }
      if (failure) throw failure;
    },
  };
}
export type CancellationNotice = ReturnType<typeof createCancellationNotice>;
let configured: CancellationNotice | undefined;
export function configureCancellationNotice(service: CancellationNotice) { configured = service; }
export function cancellationNotice(): CancellationNotice {
  if (!configured) throw new AppError('unavailable', 'Cancellation notices are not configured');
  return configured;
}
