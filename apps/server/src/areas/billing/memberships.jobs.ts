// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { membershipService } from './memberships.routes.js';
import type { MembershipService } from './memberships.js';

export function createMembershipJobs(read: () => MembershipService = membershipService): readonly JobRegistration[] {
  return [{ id: 'billing.memberships.dates', cron: '0 0 * * *',
    async handler(_payload, context) { await read().processDates(context.gymId, context.timezone); } }];
}
export const jobs = createMembershipJobs();
