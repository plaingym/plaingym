// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { classSessions, emailDeliveries, forGym, members, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { idSchema } from '@plaingym/shared/contracts';
import { z } from 'zod';
import { clock as systemClock } from '../../core/clock.js';
import { createEmailDeliveries, deliveryAcceptance, MemberEmail, type Email } from '../../infra/email/index.js';
import { commandDigest, emailInFlightMs } from '../../infra/email/deliveries.js';
import type { Jobs, JobTransaction } from '../../infra/jobs/index.js';
import { createGymSettingsAccessor, createSettingsService } from '../settings/settings.js';
import { renderCancellationNotice } from '../../emails/announcements/cancellation.js';
import { addressEquals } from './audience.sql.js';

export const cancellationNoticeJob = 'announcements.cancellation';
// Stored payloads tolerate additional keys when a release rolls back.
export const cancellationNoticePayload = z.object({
  sessionId: idSchema, memberIds: z.array(idSchema), note: z.string().max(1_000),
});
type Notice = z.infer<typeof cancellationNoticePayload>;
export interface CancellationNoticeOptions {
  scope?: typeof forGym; clock?: Clock; jobs: Jobs;
  /** The gym's SMTP resolver, or the demo outbox when demo mode is enabled. */
  mailer(gymId: string): Promise<Email | null>;
  origin(gymId: string): Promise<string>;
  demoMode?: boolean;
  demoEmailFor?(gymId: string): Email;
}
const noticeKey = (sessionId: string, memberId: string) => `schedule-cancel-notice:${sessionId}:${memberId}`;

export function createCancellationNotice(options: CancellationNoticeOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? systemClock;
  const settings = createGymSettingsAccessor({ scope }), details = createSettingsService({ scope });
  const deliveries = createEmailDeliveries({ scope, clock });
  const demo = options.demoMode ?? process.env.DEMO_MODE === 'true';

  async function group(tx: Transaction, notice: Notice, address: string) {
    // Inspect the whole address, including members outside this session. A global email preference or an
    // undeliverable address blocks it; announcement-only preferences never affect booking notices.
    const rows = await tx.select({ id: members.id, email: members.email, firstName: members.firstName, lastName: members.lastName,
      anonymizedAt: members.anonymizedAt, optOut: members.emailOptOut, deliverable: members.emailDeliverable })
      .from(members).where(addressEquals(address)).orderBy(asc(members.id));
    if (rows.some(row => row.optOut || !row.deliverable)) return [];
    const ids = new Set(notice.memberIds);
    return rows.filter(row => ids.has(row.id) && !row.anonymizedAt);
  }
  async function reserve(gymId: string, notice: Notice, address: string) {
    return scope(gymId, async tx => {
      // Only reservations are serialized: SMTP always runs after this transaction commits.
      const [session] = await tx.select().from(classSessions).where(eq(classSessions.id, notice.sessionId)).for('update');
      if (!session || session.status !== 'cancelled') return;
      const current = await group(tx, notice, address);
      if (!current.length) return;
      const key = noticeKey(notice.sessionId, current[0]!.id), digest = commandDigest([notice.sessionId, address]);
      // Both stable member keys and destination digests survive retries and address changes/convergence.
      const previous = await tx.select().from(emailDeliveries)
        .where(and(eq(emailDeliveries.gymId, gymId), or(eq(emailDeliveries.key, key), eq(emailDeliveries.commandDigest, digest))));
      if (previous.some(row => row.state === 'sending' && row.updatedAt.getTime() > clock.now().getTime() - emailInFlightMs))
        throw new AppError('conflict', 'Cancellation notice is in flight');
      if (previous.length) return;
      const reserved = await deliveries.reserve(tx, gymId, key, digest);
      return { reserved, session, current };
    });
  }
  return {
    async enqueue(transaction: JobTransaction, payload: Notice, timezone: string) {
      const notice = cancellationNoticePayload.parse(payload);
      await options.jobs.enqueue(cancellationNoticeJob, notice, { gymId: transaction.gymId, timezone,
        idempotencyKey: `schedule-cancel-notice:${notice.sessionId}`, maxAttempts: 12 }, transaction);
    },
    async run(payload: unknown, gymId: string) {
      const notice = cancellationNoticePayload.parse(payload);
      const gym = await settings.get(gymId);
      if (!gym.memberEmailsEnabled) return;
      const addresses = new Set<string>();
      // Bound query parameter counts even for a large roster. Only the cancellation's snapshot may receive mail.
      for (let offset = 0; offset < notice.memberIds.length; offset += 100) {
        // The stored address is the same normalization `group` looks up.
        const rows = await scope(gymId, tx => tx.select({ address: members.emailAddress }).from(members)
          .where(inArray(members.id, notice.memberIds.slice(offset, offset + 100))));
        for (const row of rows) if (row.address) addresses.add(row.address);
      }
      if (!addresses.size) return;
      const origin = new URL(await options.origin(gymId));
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
        throw new AppError('unavailable', 'Cancellation notices require a canonical HTTPS origin');
      if (demo && !options.demoEmailFor) throw new AppError('unavailable', 'Cancellation demo outbox is not configured');
      const email = demo ? options.demoEmailFor!(gymId) : await options.mailer(gymId);
      if (!email) throw new AppError('unavailable', 'Cancellation mail is not configured');
      const gymName = (await details.get(gymId)).name;
      let deferred = false;
      for (const address of addresses) {
        let reservation: Awaited<ReturnType<typeof reserve>>;
        try { reservation = await reserve(gymId, notice, address); }
        catch (error) { if (error instanceof AppError && error.code === 'conflict') { deferred = true; continue; } throw error; }
        if (!reservation) continue;
        const { reserved, session } = reservation;
        let attempted = false;
        let outcome: { status: 'sent' | 'suppressed' | 'failed'; reason?: string };
        try {
          const message = await renderCancellationNotice({ gymName, name: session.name, startsAt: session.startsAt, timezone: gym.timezone,
            memberNames: reservation.current.map(row => `${row.firstName} ${row.lastName}`), note: notice.note, scheduleUrl: new URL('/portal/schedule', origin).href });
          // Reload the group at the last boundary so an erasure or address change cannot disclose another member's name.
          const guarded: Email = { async sendEmail() {
            const current = await scope(gymId, tx => group(tx, notice, address));
            if (!current.length) return { status: 'suppressed', reason: 'opt_out' };
            const latest = await renderCancellationNotice({ gymName, name: session.name, startsAt: session.startsAt, timezone: gym.timezone,
              memberNames: current.map(row => `${row.firstName} ${row.lastName}`), note: notice.note, scheduleUrl: new URL('/portal/schedule', origin).href });
            return new MemberEmail({ gymId, memberId: current[0]!.id, email, settings, forGym: scope }).sendEmail({ to: address, ...latest });
          } };
          attempted = true;
          const result = await deliveries.attempt(reserved, guarded, { to: address, ...message });
          outcome = { status: result.status };
        } catch (error) {
          if (!attempted) { await deliveries.release(reserved); throw error; }
          // This address is decided, including an uncertain acceptance. A failed address must not strand the rest.
          outcome = { status: 'failed', reason: deliveryAcceptance(error) };
        }
        await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'schedule.cancellation_notice_decided',
          targetType: 'class_session', targetId: notice.sessionId, after: { memberId: reservation.current[0]!.id, ...outcome }, occurredAt: clock.now() }));
      }
      if (deferred) throw new AppError('conflict', 'Cancellation notice is in flight');
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
