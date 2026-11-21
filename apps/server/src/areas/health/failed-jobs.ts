// SPDX-License-Identifier: AGPL-3.0-only
import { forGym, writeAudit } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { clock as systemClock } from '../../core/clock.js';
import { withJobTransaction } from '../../infra/jobs/index.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';

type Acknowledging = Pick<PostgresJobs, 'acknowledgeFailedThrough'>;

/**
 * The Background jobs tile's Acknowledge failed jobs action: clears the failed jobs the tile counted, those that
 * failed by `through` (the tile's check time, never later than now). The jobs aren't run again; one that fails later shows again.
 */
export function createFailedJobsAcknowledgement(options: { scope?: typeof forGym; clock?: Clock; queue?: Acknowledging } = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? systemClock;
  let queue = options.queue;
  return {
    async acknowledge(actor: { gymId: string; userId: string }, through: string): Promise<{ acknowledged: number }> {
      queue ??= new PostgresJobs({ clock });
      const jobs = queue;
      return withJobTransaction(scope, actor.gymId, async transaction => {
        const now = clock.now(), requested = new Date(through);
        const cutoff = requested.getTime() < now.getTime() ? requested : now;
        const acknowledged = await jobs.acknowledgeFailedThrough({ gymId: actor.gymId, through: cutoff, at: now }, transaction);
        if (acknowledged > 0) await writeAudit(transaction.tx, { gymId: actor.gymId, actorKind: 'user', actorUserId: actor.userId,
          action: 'health.failed_jobs.acknowledged', targetType: 'gym', targetId: actor.gymId,
          after: { acknowledged, through: cutoff.toISOString() }, occurredAt: now });
        return { acknowledged };
      });
    },
  };
}
export type FailedJobsAcknowledgement = ReturnType<typeof createFailedJobsAcknowledgement>;
