// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { forSystem, gyms } from '@plaingym/db';
import type { PostgresJobsOptions } from '../infra/jobs/postgres.js';

/** Suspension overrides an install's more specific job policy without dropping queued work. */
export function createGymJobPolicy(options: {
  system?: typeof forSystem;
  eligibleGym?: PostgresJobsOptions['eligibleGym'];
} = {}): NonNullable<PostgresJobsOptions['eligibleGym']> {
  const system = options.system ?? forSystem;
  return async gymId => {
    const policy = options.eligibleGym ? await options.eligibleGym(gymId) : true;
    // Read status last: a demo policy can return skip after observing a concurrent suspension.
    const [gym] = await system(tx => tx.select({ status: gyms.status }).from(gyms).where(eq(gyms.id, gymId)));
    // Suspension preserves queued work until deletion cascades it or the gym becomes active again.
    if (!gym || gym.status !== 'active') return 'defer';
    return policy;
  };
}
