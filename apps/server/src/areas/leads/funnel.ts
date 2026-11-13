// SPDX-License-Identifier: AGPL-3.0-only
import { forGym } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { leadFunnelQuerySchema, type LeadFunnelQuery, type LeadFunnelResponse } from '@plaingym/shared/contracts';
import { addDays, localMidnight } from '@plaingym/shared/time';
import { funnelAggregate } from './funnel.query.js';

export function createLeadFunnelService(scope: typeof forGym = forGym) {
  return {
    async get(context: { gymId: string; timezone: string }, input: LeadFunnelQuery): Promise<LeadFunnelResponse> {
      const parsed = leadFunnelQuerySchema.safeParse(input);
      if (!parsed.success) throw new AppError('invalid_request', 'Invalid lead funnel range');
      const { from, to } = parsed.data;
      const start = localMidnight(from, context.timezone);
      const end = localMidnight(addDays(to, 1), context.timezone);
      const sources = await scope(context.gymId, tx => funnelAggregate(tx, context.gymId, start, end));
      return { data: { from, to, timezone: context.timezone, sources: [...sources] } };
    },
  };
}
