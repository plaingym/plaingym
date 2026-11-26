// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { announcements, auditEvents, classSessions, forGym, writeAudit } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { clock as systemClock } from '../../core/clock.js';
import type { JobRegistration } from '../../core/registry.js';
import { resetFailedJobs, type JobRecovery } from '../../infra/jobs/index.js';
import { announcementSendJob } from './send.js';
import { announcementSmsJob, announcementSmsJobKey } from './send.sms.js';
import { cancellationNoticeJob, cancellationNoticeKeyPrefix, noticeScope } from './cancellation.js';

export const announcementRecoveryJob = 'announcements.recover';
export interface AnnouncementRecoveryOptions {
  scope?: typeof forGym;
  clock?: Clock;
  jobs: JobRecovery;
}
const batchSize = 100, initialDelayMs = 15 * 60_000, maximumDelayMs = 24 * 60 * 60_000;
// Seven previous resets reach the one-day cap. Read no more history than that.
const historyLimit = 7;

export function createAnnouncementRecovery(options: AnnouncementRecoveryOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? systemClock;
  async function retry(gymId: string, name: string, ids: string[], key: (id: string) => string,
    action: string, targetType: string) {
    const targets = new Map(ids.map(id => [key(id), id]));
    const delays = new Map<string, number>();
    // The queue's compare-and-set admits only one sweep. No second job or delivery key is created.
    return resetFailedJobs(options.jobs, name, [...targets.keys()], gymId, async job => {
      const targetId = targets.get(job.idempotencyKey)!;
      const history = await scope(gymId, tx => tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
        eq(auditEvents.gymId, gymId), eq(auditEvents.targetId, targetId), eq(auditEvents.action, action)))
        .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(historyLimit));
      const now = clock.now(), delay = Math.min(maximumDelayMs, initialDelayMs * 2 ** history.length);
      if (now.getTime() - job.failedAt.getTime() < delay) return null;
      delays.set(job.jobId, delay);
      return now;
    }, async (job, now) => {
      await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action, targetType,
        targetId: targets.get(job.idempotencyKey)!, after: { jobId: job.jobId, delayMs: delays.get(job.jobId)! }, occurredAt: now }));
    });
  }
  return {
    async run(gymId: string) {
      let recovered = 0;
      let cursor: string | undefined;
      for (;;) {
        const rows = await scope(gymId, tx => tx.select({ id: announcements.id }).from(announcements).where(and(
          eq(announcements.status, 'sending'), cursor ? gt(announcements.id, cursor) : undefined))
          .orderBy(asc(announcements.id)).limit(batchSize));
        if (!rows.length) break;
        // Include an empty pending set: a crash can also interrupt the final completion write.
        recovered += await retry(gymId, announcementSendJob, rows.map(row => row.id), id => id,
          'announcement.delivery_retried', 'announcement');
        cursor = rows.at(-1)!.id;
      }
      cursor = undefined;
      for (;;) {
        const rows = await scope(gymId, tx => tx.select({ id: announcements.id, scheduledFor: announcements.smsScheduledFor }).from(announcements)
          .where(and(isNotNull(announcements.smsBody), isNull(announcements.smsCompletedAt), cursor ? gt(announcements.id, cursor) : undefined))
          .orderBy(asc(announcements.id)).limit(batchSize));
        if (!rows.length) break;
        const schedules = new Map(rows.map(row => [row.id, row.scheduledFor]));
        recovered += await retry(gymId, announcementSmsJob, rows.map(row => row.id), id => announcementSmsJobKey(id, schedules.get(id) ?? null),
          'announcement.sms_delivery_retried', 'announcement');
        cursor = rows.at(-1)!.id;
      }
      cursor = undefined;
      for (;;) {
        const rows = await scope(gymId, tx => tx.select({ id: classSessions.id, restoreCount: classSessions.restoreCount }).from(classSessions).where(and(
          eq(classSessions.status, 'cancelled'), gt(classSessions.startsAt, clock.now()),
          cursor ? gt(classSessions.id, cursor) : undefined))
          .orderBy(asc(classSessions.id)).limit(batchSize));
        if (!rows.length) break;
        // The original job holds the roster and note. Never reconstruct them from current bookings.
        // Only the current cancellation's job is retried: one from before a restore would send nothing.
        const rounds = new Map(rows.map(row => [row.id, row.restoreCount]));
        recovered += await retry(gymId, cancellationNoticeJob, rows.map(row => row.id),
          id => cancellationNoticeKeyPrefix + noticeScope(id, rounds.get(id)), 'schedule.cancellation_notice_retried', 'class_session');
        cursor = rows.at(-1)!.id;
      }
      return { recovered };
    },
  };
}

/** Register alongside the announcement jobs with the runtime's queue, gym scope and clock. */
export function createAnnouncementRecoveryJobs(options: AnnouncementRecoveryOptions): readonly JobRegistration[] {
  const recovery = createAnnouncementRecovery(options);
  return [{ id: announcementRecoveryJob, cron: '*/15 * * * *', lane: 'batch', async handler(_payload, context) {
    await recovery.run(context.gymId);
  } }];
}
