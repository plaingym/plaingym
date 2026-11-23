// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, or } from 'drizzle-orm';
import { auditEvents, classSessions, emailDeliveries, forGym, writeAudit, type Transaction } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { cancellationNoticeChannelsSchema, idSchema } from '@plaingym/shared/contracts';
import { z } from 'zod';
import { clock as systemClock } from '../../core/clock.js';
import { logInfo } from '../../core/log.js';
import { createEmailDeliveries, DeliveryError, deliveryAcceptance, type Email } from '../../infra/email/index.js';
import { commandDigest, emailInFlightMs } from '../../infra/email/deliveries.js';
import { logEmailSuppression } from '../../infra/email/member.js';
import type { JobTransaction } from '../../infra/jobs/index.js';
import { createGymSettingsAccessor, createSettingsService } from '../settings/settings.js';
import { renderRestoreNotice } from '../../emails/announcements/restored.js';
import { readAddressGroup } from './audience.js';
import { cancellationDecisionMemberId } from './cancellation.sql.js';
import type { CancellationNoticeOptions } from './cancellation.js';
import { readMemberNoticeEmails } from '../bookings/bookings.recipients.js';
import { activeMembers, createRestoreSms, restoreHolds, restoreScope } from './restored.sms.js';

export const restoreNoticeJob = 'announcements.restore_notice';
/** One restore's notice: the members whose places came back, the channels staff chose and the session's restore count. */
export const restoreNoticePayload = z.object({ sessionId: idSchema, memberIds: z.array(idSchema),
  round: z.number().int().positive(), channels: cancellationNoticeChannelsSchema });
type Notice = z.infer<typeof restoreNoticePayload>;
/** Configured with the same options as the cancellation notice. */
export type RestoreNoticeOptions = CancellationNoticeOptions;
/** One restore's notice to one address group is keyed `<prefix><session ID>.<restore count>:<first member's ID>`. */
export const restoreNoticeKeyPrefix = 'schedule-restore-notice:';
const decisionAction = 'schedule.restore_notice_decided';

export function createRestoreNotice(options: RestoreNoticeOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? systemClock;
  const settings = createGymSettingsAccessor({ scope }), details = createSettingsService({ scope });
  const deliveries = createEmailDeliveries({ scope, clock });
  const demo = options.demoMode ?? process.env.DEMO_MODE === 'true';
  const sms = createRestoreSms({ scope, clock, settings, ...(options.sms ? { sms: options.sms } : {}) });

  async function group(tx: Transaction, gymId: string, notice: Notice, address: string, ids: readonly string[]) {
    // Inspect the whole address, including members outside this session. A global email preference or an
    // undeliverable address blocks it; announcement-only preferences never affect booking notices.
    const rows = await readAddressGroup(tx, address);
    const blocked = rows.some(row => row.emailOptOut) ? 'opt_out' as const
      : rows.some(row => !row.emailDeliverable) ? 'undeliverable' as const : null;
    if (blocked) return { rows: [], blocked };
    // Membership is bounded by the job's members who still hold a place in the session.
    const active = await activeMembers(tx, notice.sessionId, [...new Set(ids)]);
    return { rows: (await readMemberNoticeEmails(tx, gymId, active)).filter(row => row.address === address), blocked };
  }
  function decide(tx: Transaction, gymId: string, notice: Notice, memberId: string,
    outcome: { status: 'sent' | 'suppressed' | 'failed'; reason?: string }) {
    return writeAudit(tx, { gymId, actorKind: 'system', action: decisionAction, targetType: 'class_session',
      targetId: notice.sessionId, after: { memberId, round: notice.round, ...outcome }, occurredAt: clock.now() });
  }
  async function reserve(gymId: string, notice: Notice, address: string, ids: readonly string[]) {
    return scope(gymId, async tx => {
      // Only reservations are serialized: SMTP always runs after this transaction commits.
      const [session] = await tx.select().from(classSessions).where(eq(classSessions.id, notice.sessionId)).for('update');
      if (!restoreHolds(session, notice.round, clock.now())) return;
      const { rows: current } = await group(tx, gymId, notice, address, ids);
      if (!current.length) return;
      const scoped = restoreScope(notice), prefix = `${restoreNoticeKeyPrefix}${scoped}:`;
      const key = prefix + current[0]!.id, digest = commandDigest(['restored', scoped, address]);
      // Both stable member keys and destination digests survive retries and address changes/convergence.
      const previous = await tx.select().from(emailDeliveries)
        .where(and(eq(emailDeliveries.gymId, gymId), or(eq(emailDeliveries.key, key), eq(emailDeliveries.commandDigest, digest))));
      if (previous.some(row => row.state === 'sending' && row.updatedAt.getTime() > clock.now().getTime() - emailInFlightMs))
        throw new AppError('conflict', 'Restore notice is in flight');
      if (previous.length) {
        // Any stored outcome can precede a crash before its audit. Recover the original member's decision without resending.
        const recoverable = previous.flatMap(row => {
          if (!row.key.startsWith(prefix)) return [];
          const memberId = idSchema.safeParse(row.key.slice(prefix.length));
          return memberId.success ? [{ memberId: memberId.data, state: row.state }] : [];
        });
        if (recoverable.length) {
          const decisions = await tx.select({ memberId: cancellationDecisionMemberId, after: auditEvents.after }).from(auditEvents).where(and(
            eq(auditEvents.gymId, gymId), eq(auditEvents.targetId, notice.sessionId), eq(auditEvents.action, decisionAction),
            inArray(cancellationDecisionMemberId, recoverable.map(row => row.memberId))));
          const decided = new Set(decisions.filter(row => (row.after as { round?: unknown } | null)?.round === notice.round)
            .map(row => row.memberId));
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
      return { reserved, session: session!, current };
    });
  }
  async function sendEmail(notice: Notice, gymId: string) {
    const gym = await settings.get(gymId);
    if (!gym.memberEmailsEnabled) return;
    const candidates = new Map<string, string[]>();
    // Bound query parameter counts even for a large roster. Only the restore's members may receive mail.
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
      throw new AppError('unavailable', 'Restore notices require a canonical HTTPS origin');
    if (demo && !options.demoEmailFor) throw new AppError('unavailable', 'Restore demo outbox is not configured');
    const email = demo ? options.demoEmailFor!(gymId) : await options.mailer(gymId);
    if (!email) throw new AppError('unavailable', 'Restore mail is not configured');
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
        // Reload the session and the group at the last boundary, so a second cancellation, an erasure, a cancelled
        // place or an address change can neither send a stale notice nor disclose another member's name.
        const guarded: Email = { async sendEmail() {
          let latest: Awaited<ReturnType<typeof renderRestoreNotice>>;
          const memberId = reservation.current[0]!.id;
          try {
            if (!(await settings.get(gymId)).memberEmailsEnabled) {
              logEmailSuppression({ event: 'email.suppressed', gymId, memberId, reason: 'disabled' });
              return { status: 'suppressed', reason: 'disabled' };
            }
            const checked = await scope(gymId, async tx => {
              const [state] = await tx.select().from(classSessions).where(eq(classSessions.id, notice.sessionId));
              return restoreHolds(state, notice.round, clock.now()) ? group(tx, gymId, notice, address, ids) : undefined;
            });
            if (!checked?.rows.length) {
              if (checked?.blocked) {
                logEmailSuppression({ event: 'email.suppressed', gymId, memberId, reason: checked.blocked });
                return { status: 'suppressed', reason: checked.blocked };
              }
              // The class was cancelled again or started, or nobody covered still holds a place here (cancelled,
              // erased, or moved): no preference blocked it, so no suppression is logged.
              logInfo('announcements.restore_notice_skipped', { gymId, sessionId: notice.sessionId, memberId,
                reason: checked ? 'no_recipient' : 'not_restored' });
              return { status: 'suppressed', reason: 'opt_out' };
            }
            const current = checked.rows;
            // A member at their own address isn't told their own name; a household address still lists who it covers.
            const showMembers = current.length !== 1 || !current[0]!.email;
            latest = await renderRestoreNotice({ gymName, name: session.name, startsAt: session.startsAt, timezone: gym.timezone,
              memberNames: current.map(row => `${row.firstName} ${row.lastName}`), showMembers,
              scheduleUrl: new URL('/portal/schedule', origin).href });
          } catch (cause) { throw new DeliveryError('not_accepted', 'Restore notice could not be prepared', { cause }); }
          // The group guard also authorizes billing addresses for members with no email of their own.
          return email.sendEmail({ to: address, ...latest });
        } };
        // The guard builds the final content exactly once, after its last address read.
        const result = await deliveries.attempt(reserved, guarded, { to: address, subject: session.name, text: '', html: '' });
        outcome = { status: result.status };
      } catch (error) {
        // This address is decided, including an uncertain acceptance. A failed address must not strand the rest.
        outcome = { status: 'failed', reason: deliveryAcceptance(error) };
      }
      await scope(gymId, tx => decide(tx, gymId, notice, reservation.current[0]!.id, outcome));
    }
    if (deferred) throw new AppError('conflict', 'Restore notice is in flight');
  }
  return {
    /** Enqueues the notice in the restore's own transaction, so both commit together or not at all. */
    async enqueue(transaction: JobTransaction, payload: Notice, timezone: string) {
      const notice = restoreNoticePayload.parse(payload);
      await options.jobs.enqueue(restoreNoticeJob, notice, { gymId: transaction.gymId, timezone,
        idempotencyKey: `${restoreNoticeKeyPrefix}${restoreScope(notice)}`, maxAttempts: 12 }, transaction);
    },
    async run(payload: unknown, gymId: string) {
      const notice = restoreNoticePayload.parse(payload);
      // An email's failure, suppression or earlier acceptance cannot prevent the independent SMS attempt.
      // When both channels fail, the email's error is reported. A channel staff didn't choose is never reserved.
      let failure: unknown;
      if (notice.channels.includes('email')) try { await sendEmail(notice, gymId); } catch (error) { failure = error; }
      if (notice.channels.includes('sms')) try { await sms.run(notice, gymId); } catch (error) { failure ??= error; }
      if (failure) throw failure;
    },
  };
}
export type RestoreNotice = ReturnType<typeof createRestoreNotice>;
let configured: RestoreNotice | undefined;
export function configureRestoreNotice(service: RestoreNotice) { configured = service; }
export function restoreNotice(): RestoreNotice {
  if (!configured) throw new AppError('unavailable', 'Restore notices are not configured');
  return configured;
}
