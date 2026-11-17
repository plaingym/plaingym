// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { forSystem, gyms } from '@plaingym/db';
import type { PostgresJobsOptions } from '../infra/jobs/postgres.js';

type GymJobState = Pick<typeof gyms.$inferSelect, 'status' | 'settings'>;
type ReadGymJobState = () => Promise<GymJobState | undefined>;

/** Suspension overrides an install's more specific job policy without dropping queued work. */
export function createGymJobPolicy(options: {
  system?: typeof forSystem;
  eligibleGym?: (gymId: string, readGym: ReadGymJobState) => ReturnType<NonNullable<PostgresJobsOptions['eligibleGym']>>;
} = {}): NonNullable<PostgresJobsOptions['eligibleGym']> {
  const system = options.system ?? forSystem;
  return async gymId => {
    // Share one lazily read snapshot with an install policy, only for this execution.
    let snapshot: Promise<GymJobState | undefined> | undefined;
    const readGym: ReadGymJobState = () => snapshot ??= system(async tx =>
      (await tx.select({ status: gyms.status, settings: gyms.settings }).from(gyms).where(eq(gyms.id, gymId)))[0]);
    const policy = options.eligibleGym ? await options.eligibleGym(gymId, readGym) : true;
    const gym = await readGym();
    // Suspension preserves queued work until deletion cascades it or the gym becomes active again.
    if (!gym || gym.status !== 'active') return 'defer';
    return policy;
  };
}
