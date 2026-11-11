// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { leadFunnelQuerySchema, leadFunnelResponseSchema, leadsContracts, leadSourceSchema, leadStageSchema,
  leadListQuerySchema, updateLeadRequestSchema, loseLeadRequestSchema, reopenLeadRequestSchema } from './leads.js';

describe('lead contracts', () => {
  it('declares all five staff lead operations', () => {
    for (const name of ['list', 'read', 'edit', 'lost', 'reopen'] as const)
      expect(leadsContracts[name].permission).toEqual({ kind: 'staff', capability: 'leads.manage' });
  });
  it('parses query defaults, repeatable stages and explicit booleans', () => {
    expect(leadListQuerySchema.parse({})).toEqual({ limit: 50, offset: 0, includeLost: false, due: false });
    expect(leadListQuerySchema.parse({ stage: ['new', 'lost'], source: 'unknown', includeLost: 'true', due: 'false', limit: '2' }))
      .toMatchObject({ stage: ['new', 'lost'], source: 'unknown', includeLost: true, due: false, limit: 2 });
  });
  it.each([{ due: 'yes' }, { includeLost: '0' }, { stage: [] }, { source: 'bad' }, { limit: '1e2' }, { offset: '-1' }, { extra: true }])('rejects invalid list filters: %j', input => {
    expect(leadListQuerySchema.safeParse(input).success).toBe(false);
  });
  it('accepts revision zero only for leads and validates edits, reasons and dates', () => {
    expect(updateLeadRequestSchema.safeParse({ revision: 0, source: null, nextFollowUpOn: null }).success).toBe(true);
    expect(reopenLeadRequestSchema.safeParse({ revision: 0 }).success).toBe(true);
    for (const input of [{ revision: -1, source: 'phone' }, { revision: 0 },
      { revision: 1, nextFollowUpOn: '2026-02-30' }, { revision: 1, nextFollowUpOn: '0000-01-01' }])
      expect(updateLeadRequestSchema.safeParse(input).success).toBe(false);
    for (const reason of ['', '  ', 'x'.repeat(501)]) expect(loseLeadRequestSchema.safeParse({ revision: 1, reason }).success).toBe(false);
    expect(loseLeadRequestSchema.parse({ revision: 0, reason: ' x ' }).reason).toBe('x');
  });
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
