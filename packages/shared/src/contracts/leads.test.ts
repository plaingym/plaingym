// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { leadFunnelQuerySchema, leadFunnelResponseSchema, leadsContracts, leadSourceSchema, leadStageSchema } from './leads.js';

describe('lead contracts', () => {
  it('declares the funnel permission and the complete source and stage sets', () => {
    expect(leadsContracts.funnel).toMatchObject({ method: 'get', path: '/api/leads/funnel',
      permission: { kind: 'staff', capability: 'leads.manage' } });
    expect(leadSourceSchema.options).toEqual(['trial_form', 'join', 'drop_in', 'walk_in', 'referral', 'phone', 'other']);
    expect(leadStageSchema.options).toEqual(['new', 'contacted', 'trial_booked', 'trial_attended', 'won', 'lost']);
  });
  it.each([
    { from: '2026-03-01', to: '2026-03-01' }, { from: '2026-03-01', to: '2028-02-29' },
    { from: '2024-02-29', to: '2026-02-27' },
  ])('accepts inclusive calendar ranges: %j', range => { expect(leadFunnelQuerySchema.safeParse(range).success).toBe(true); });
  it.each([
    {}, { from: '2026-02-30', to: '2026-03-01' }, { from: 'invalid', to: 'invalid' },
    { from: '0000-01-01', to: '0000-12-31' },
    { from: '2026-03-02', to: '2026-03-01' }, { from: '2026-03-01', to: '2028-03-01' },
    { from: '2024-02-29', to: '2026-02-28' }, { from: '2026-01-01', to: '2026-01-01', extra: 'bad' },
  ])('rejects invalid, reversed or excessive ranges without throwing: %j', range => {
    expect(leadFunnelQuerySchema.safeParse(range).success).toBe(false);
  });
  it('validates unknown sources and nonnegative counts', () => {
    const data = { from: '2026-03-01', to: '2026-03-01', timezone: 'America/New_York',
      sources: [{ source: 'unknown', leads: 1, trialAttended: 0, won: 0, lost: 0, open: 1 }] };
    expect(leadFunnelResponseSchema.safeParse({ data }).success).toBe(true);
    data.sources[0]!.won = -1;
    expect(leadFunnelResponseSchema.safeParse({ data }).success).toBe(false);
  });
});
