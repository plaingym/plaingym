// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, errorResponse, staffRoles, type StaffRole } from '@plaingym/shared';
import { leadFunnelResponseSchema, type LeadFunnelQuery } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { createServerRegistry } from '../../core/registry.js';
import { authorize } from '../staff/auth.permissions.js';
import { measureReportStatements } from '../reports/statements.test-helper.js';
import { createLeadFunnelService } from './funnel.js';
import { createLeadFunnelRoutes } from './funnel.routes.js';

const db = useTestDatabase(), factory = createFactories(db), service = createLeadFunnelService(db.forGym);
const query = { from: '2026-03-01', to: '2026-03-31' };
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId, { timezone: 'America/New_York' });
  return { gymId, timezone: 'America/New_York' };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function lead(f: Fixture, createdAt: string, source: string | null = null, stage = 'new', trialAttended = false, erased = false) {
  const member = await factory('members', f.gymId, { status: erased ? 'cancelled' : 'prospect', createdAt: new Date(createdAt),
    anonymizedAt: erased ? new Date('2026-04-01Z') : null });
  await factory('leads', f.gymId, { memberId: member.id, source, stage,
    // Deliberately different from member.createdAt: the member date defines the cohort.
    createdAt: new Date('2026-05-01Z'), trialAttendedAt: trialAttended ? new Date('2026-03-15Z') : null,
    wonAt: stage === 'won' ? new Date('2026-03-20Z') : null, lostAt: stage === 'lost' ? new Date('2026-03-20Z') : null });
}
function app(f: Fixture, roles: readonly StaffRole[] = ['owner'], principal?: Principal) {
  const server = new OpenAPIHono<RequestEnvironment>();
  server.use('*', async (c, next) => {
    c.set('context', { requestId: 'funnel-test', gym: { ...f, enabledModules: new Set() }, clock: new TestClock('2026-11-10Z'),
      principal: principal ?? { kind: 'staff', gymId: f.gymId, userId: uuidv7(), roles } });
    await next();
  });
  server.onError((error, c) => c.json(errorResponse(error, 'funnel-test'), error instanceof AppError ? error.status : 500));
  createServerRegistry({ routes: createLeadFunnelRoutes(service) }).mount(server, authorize, new Set());
  return server;
}
const url = (input = query) => '/api/leads/funnel?' + new URLSearchParams(input);

describe('lead funnel with real PostgreSQL and RLS', () => {
  it('counts known source cohorts across both local-midnight edges and DST, retaining erased leads', async () => {
    const f = await fixture();
    await lead(f, '2026-03-01T04:59:59.999Z', 'trial_form'); // Just before local start.
    await lead(f, '2026-03-01T05:00:00.000Z', 'trial_form', 'trial_attended', true);
    await lead(f, '2026-03-01T05:00:00.001Z', 'trial_form', 'won', true, true);
    await lead(f, '2026-03-31T23:00:00Z', 'trial_form', 'lost', true);
    await lead(f, '2026-04-01T03:59:59.999Z', 'phone', 'contacted'); // Just before exclusive end after DST.
    await lead(f, '2026-04-01T04:00:00.000Z', 'phone', 'won');
    await lead(f, '2026-04-01T04:00:00.001Z', 'phone', 'lost');
    await lead(f, '2026-03-08T07:00:00Z', 'phone', 'won');
    await lead(f, '2026-03-15T12:00:00Z', null, 'trial_booked');
    await lead(f, '2026-03-15T13:00:00Z', null, 'lost');
    const response = leadFunnelResponseSchema.parse(await service.get(f, query));
    expect(response).toEqual({ data: { ...query, timezone: f.timezone, sources: [
      { source: 'phone', leads: 2, trialAttended: 0, won: 1, lost: 0, open: 1 },
      { source: 'trial_form', leads: 3, trialAttended: 3, won: 1, lost: 1, open: 1 },
      { source: 'unknown', leads: 2, trialAttended: 0, won: 0, lost: 1, open: 1 },
    ] } });
    expect((await service.get(f, { from: '2026-03-01', to: '2026-03-01' })).data.sources)
      .toEqual([{ source: 'trial_form', leads: 2, trialAttended: 2, won: 1, lost: 0, open: 1 }]);
  });
  it('counts row-less prospect and trial members as unknown open leads, excluding ordinary members', async () => {
    const f = await fixture();
    for (const status of ['prospect', 'trial', 'active', 'cancelled'])
      await factory('members', f.gymId, { status, createdAt: new Date('2026-03-15Z') });
    expect((await service.get(f, query)).data.sources).toEqual([
      { source: 'unknown', leads: 2, trialAttended: 0, won: 0, lost: 0, open: 2 },
    ]);
  });
  it('never counts gym B leads through either the service or HTTP', async () => {
    const a = await fixture(), b = await fixture();
    await lead(a, '2026-03-15Z', 'phone');
    await lead(b, '2026-03-15Z', 'referral', 'won');
    await lead(b, '2026-03-15Z', 'referral', 'won');
    const response = await app(a).request(url());
    expect(response.status).toBe(200);
    expect(leadFunnelResponseSchema.parse(await response.json()).data.sources).toEqual([
      { source: 'phone', leads: 1, trialAttended: 0, won: 0, lost: 0, open: 1 },
    ]);
    expect((await service.get(b, query)).data.sources).toEqual([
      { source: 'referral', leads: 2, trialAttended: 0, won: 2, lost: 0, open: 0 },
    ]);
  });
  it.each(staffRoles)('enforces leads.manage for %s before validation and disables caching', async role => {
    const f = await fixture(), response = await app(f, [role]).request(url());
    expect(response.status).toBe(role === 'coach' ? 403 : 200);
    if (response.status === 200) {
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(leadFunnelResponseSchema.parse(await response.json()).data.sources).toEqual([]);
    }
    expect((await app(f, [role]).request('/api/leads/funnel?from=invalid')).status).toBe(role === 'coach' ? 403 : 400);
  });
  it('denies anonymous, member, kiosk and foreign-gym staff principals', async () => {
    const f = await fixture(), userId = uuidv7();
    const principals: Principal[] = [{ kind: 'anonymous' },
      { kind: 'member', userId, scope: { gymId: f.gymId, householdId: uuidv7(), role: 'payer' } },
      { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() },
      { kind: 'staff', gymId: uuidv7(), userId, roles: ['owner'] }];
    for (const principal of principals)
      expect((await app(f, [], principal).request(url())).status).toBe(principal.kind === 'anonymous' ? 401 : 403);
  });
  it.each([
    { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-03-02', to: '2026-03-01' },
    { from: '0000-01-01', to: '0000-12-31' },
    { from: '2026-03-01', to: '2028-03-01' },
  ])('rejects invalid ranges on the service and HTTP paths: %j', async range => {
    const f = await fixture();
    await expect(service.get(f, range)).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await app(f).request(url(range))).status).toBe(400);
  });
  it('uses one aggregate in one scope for short and 24-month ranges', async () => {
    const f = await fixture();
    const measure = (range: LeadFunnelQuery) => measureReportStatements(db.appUrl, scope => createLeadFunnelService(scope).get(f, range));
    const short = await measure(query);
    for (const source of ['phone', 'other', 'trial_form']) await lead(f, '2026-03-15Z', source);
    const long = await measure({ from: '2025-01-01', to: '2026-12-31' });
    expect(short.reportStatements).toHaveLength(1); expect(long.reportStatements).toHaveLength(1);
    expect(short.statements).toHaveLength(4); expect(long.statements).toHaveLength(4);
    expect(long.result.data.sources.reduce((sum, row) => sum + row.leads, 0)).toBe(3);
  });
  it('handles the final four-digit calendar date without a PostgreSQL timestamp parse error', async () => {
    const f = await fixture();
    expect((await service.get(f, { from: '9999-12-31', to: '9999-12-31' })).data.sources).toEqual([]);
  });
});
