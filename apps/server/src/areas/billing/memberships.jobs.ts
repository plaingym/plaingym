// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { membershipService } from './memberships.routes.js';
import type { MembershipService } from './memberships.js';
import { priceNotice, priceNoticeJob, type PriceNotice } from './memberships.price-notice.js';

export function createMembershipJobs(read: () => MembershipService = membershipService,
  readNotice: () => PriceNotice = priceNotice): readonly JobRegistration[] {
  return [{ id: 'billing.memberships.dates', cron: '0 0 * * *',
    async handler(_payload, context) { await read().processDates(context.gymId, context.timezone); } },
  { id: priceNoticeJob, async handler(payload, context) { await readNotice().run(payload, context.gymId); } }];
}
export const jobs = createMembershipJobs();
