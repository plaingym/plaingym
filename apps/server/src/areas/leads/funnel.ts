// SPDX-License-Identifier: AGPL-3.0-only
import { forGym } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { leadFunnelQuerySchema, type LeadFunnelQuery, type LeadFunnelResponse } from '@plaingym/shared/contracts';
import { addDays, zonedInstant } from '@plaingym/shared/time';
import { funnelAggregate } from './funnel.query.js';

export function createLeadFunnelService(scope: typeof forGym = forGym) {
  return {
    async get(context: { gymId: string; timezone: string }, input: LeadFunnelQuery): Promise<LeadFunnelResponse> {
      const parsed = leadFunnelQuerySchema.safeParse(input);
      if (!parsed.success) throw new AppError('invalid_request', 'Invalid lead funnel range');
      const { from, to } = parsed.data;
      const start = zonedInstant(from, '00:00', context.timezone, { gap: 'shift' })!;
      const end = zonedInstant(addDays(to, 1), '00:00', context.timezone, { gap: 'shift' })!;
      const sources = await scope(context.gymId, tx => funnelAggregate(tx, context.gymId, start, end));
      return { data: { from, to, timezone: context.timezone, sources: [...sources] } };
    },
  };
}
