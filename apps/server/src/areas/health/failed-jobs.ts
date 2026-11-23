// SPDX-License-Identifier: AGPL-3.0-only
import { forGym, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { clock as systemClock } from '../../core/clock.js';
import { withJobTransaction } from '../../infra/jobs/index.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';

type Acknowledging = Pick<PostgresJobs, 'acknowledgeFailedVersion'>;

/**
 * The Background jobs tile's Acknowledge failed jobs action: clears exactly the failed jobs the tile counted, named by its
 * `failedVersion`, or refuses with a conflict when that set changed. `through` is the tile's check time, kept in the audit.
 * The jobs aren't run again; one that fails later shows again.
 */
export function createFailedJobsAcknowledgement(options: { scope?: typeof forGym; clock?: Clock; queue?: Acknowledging } = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? systemClock;
  let queue = options.queue;
  return {
    async acknowledge(actor: { gymId: string; userId: string }, request: { through: string; failedVersion: string }):
      Promise<{ acknowledged: number }> {
      queue ??= new PostgresJobs({ clock });
      const jobs = queue;
      return withJobTransaction(scope, actor.gymId, async transaction => {
        const now = clock.now();
        const result = await jobs.acknowledgeFailedVersion({ gymId: actor.gymId, failedVersion: request.failedVersion, at: now }, transaction);
        if (result === 'changed') throw new AppError('conflict', 'Failed jobs changed');
        if (result.acknowledged > 0) await writeAudit(transaction.tx, { gymId: actor.gymId, actorKind: 'user', actorUserId: actor.userId,
          action: 'health.failed_jobs.acknowledged', targetType: 'gym', targetId: actor.gymId,
          after: { acknowledged: result.acknowledged, through: request.through }, occurredAt: now });
        return { acknowledged: result.acknowledged };
      });
    },
  };
}
export type FailedJobsAcknowledgement = ReturnType<typeof createFailedJobsAcknowledgement>;
