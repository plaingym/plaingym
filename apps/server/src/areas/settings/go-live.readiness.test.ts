// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, memberships, paymentMethods, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { goLiveChecklistResponseSchema, updateGoLiveRequestSchema } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { createApp } from '../../app.js';
import { areaContributions } from '../../core/registry-areas.js';
import { authorize } from '../staff/auth.permissions.js';
import { createGoLiveService, configureGoLive } from './go-live.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(timezone = 'America/Vancouver') {
  const gymId = uuidv7(), clock = new TestClock('2026-10-26T06:30:00Z'); // Still October 25 in Vancouver.
  await factory('gyms', gymId, { timezone, stripeConfig: 'opaque-encrypted-configuration' });
  const household = await factory('households', gymId, { stripeCustomerId: 'cus_ready' });
  const member = await factory('members', gymId, { householdId: household.id, firstName: 'Ana', lastName: 'Silva', status: 'active' });
  const plan = await factory('plans', gymId, { name: 'Monthly classes' });
  const makeMembership = (overrides: Partial<typeof memberships.$inferInsert> = {}) => factory('memberships', gymId, {
    householdId: household.id, memberId: member.id, planId: plan.id, status: 'active', nextDueOn: '2026-10-25', ...overrides,
  });
  const service = createGoLiveService({ scope: db.forGym, clock, smtpConfigured: async () => true });
  const context = { gymId, actor: { kind: 'system' as const } };
  return { gymId, clock, household, member, plan, makeMembership, service, context };
}
const status = (data: Awaited<ReturnType<ReturnType<typeof createGoLiveService>['checklist']>>, id: string) => data.items.find(i => i.id === id)!.status;
const confirmation = (data: Awaited<ReturnType<ReturnType<typeof createGoLiveService>['checklist']>>) =>
  data.pastDueMemberships.map(({ id, nextDueOn, revision }) => ({ id, nextDueOn, revision }));

describe('go-live billing readiness', () => {
  it('lists only active memberships before the local date, including annual dates, and isolates gyms', async () => {
    const a = await fixture(), b = await fixture('Pacific/Kiritimati');
    const old = await a.makeMembership({ nextDueOn: '2026-10-24', interval: 'annual', anniversaryOn: '2026-10-24' });
    await a.makeMembership(); await a.makeMembership({ nextDueOn: '2026-10-26' });
    for (const state of ['pending', 'trial', 'frozen', 'cancelled']) await a.makeMembership({ status: state, nextDueOn: '2026-10-01' });
    const other = await b.makeMembership();
    const checklist = await a.service.checklist(a.gymId);
    expect(checklist.pastDueMemberships).toEqual([{ id: old.id, revision: 1, nextDueOn: '2026-10-24',
      memberId: a.member.id, memberName: 'Ana Silva', planName: 'Monthly classes' }]);
    expect(status(checklist, 'past_due_dates')).toBe('needs_attention');
    expect((await b.service.checklist(b.gymId)).pastDueMemberships.map(m => m.id)).toEqual([other.id]);
    a.clock.set('2026-10-26T07:00:00Z');
    expect((await a.service.checklist(a.gymId)).pastDueMemberships).toHaveLength(2);
  });
  it('rejects missing, partial, duplicate, foreign and changed confirmations without changing either switch', async () => {
    const f = await fixture(), foreign = await fixture();
    const row = await f.makeMembership({ nextDueOn: '2026-10-24' });
    await foreign.makeMembership({ nextDueOn: '2026-10-23' });
    const before = await f.service.checklist(f.gymId), confirmed = confirmation(before);
    for (const value of [undefined, [], [...confirmed, ...confirmed], confirmation(await foreign.service.checklist(foreign.gymId)),
      [{ ...confirmed[0]!, nextDueOn: '2026-10-23' }], [{ ...confirmed[0]!, revision: 2 }]]) {
      await expect(f.service.update(f.context, { revision: before.revision, billingEnabled: true, memberEmailsEnabled: true,
        ...(value ? { confirmedPastDueDates: value } : {}) })).rejects.toMatchObject({ code: 'conflict' });
    }
    await db.forGym(f.gymId, tx => tx.update(memberships).set({ nextDueOn: '2026-10-23', revision: 2 }).where(eq(memberships.id, row.id)));
    await expect(f.service.update(f.context, { revision: before.revision, billingEnabled: true, confirmedPastDueDates: confirmed }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(await f.service.checklist(f.gymId)).toMatchObject({ revision: before.revision, billingEnabled: false, memberEmailsEnabled: false });
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'settings.go_live.updated')))).toEqual([]);
  });
  it('requires newly past dates to be reviewed after midnight, then audits the exact confirmation without names', async () => {
    const f = await fixture(); await f.makeMembership();
    const before = await f.service.checklist(f.gymId);
    f.clock.set('2026-10-26T07:00:00Z');
    await expect(f.service.update(f.context, { revision: before.revision, billingEnabled: true })).rejects.toMatchObject({ code: 'conflict' });
    const latest = await f.service.checklist(f.gymId), confirmed = confirmation(latest);
    const saved = await f.service.update(f.context, { revision: latest.revision, billingEnabled: true, confirmedPastDueDates: confirmed });
    expect(saved.billingEnabled).toBe(true);
    const events = await db.forGym(f.gymId, tx => tx.select().from(auditEvents));
    expect(events.find(e => e.action === 'settings.go_live.past_due_dates_confirmed')).toMatchObject({ after: { memberships: confirmed }, occurredAt: f.clock.now() });
    expect(JSON.stringify(events)).not.toMatch(/Ana|Monthly classes|opaque-encrypted/);
    // Pausing and changing email never require confirmation, even with past dates.
    const paused = await f.service.update(f.context, { revision: saved.revision, billingEnabled: false });
    expect((await f.service.update(f.context, { revision: paused.revision, memberEmailsEnabled: true })).memberEmailsEnabled).toBe(true);
  });
  it('rejects a newly added overdue membership after a checklist was reviewed', async () => {
    const f = await fixture(); await f.makeMembership({ nextDueOn: '2026-10-24' });
    const before = await f.service.checklist(f.gymId);
    await f.makeMembership({ nextDueOn: '2026-10-23' });
    await expect(f.service.update(f.context, { revision: before.revision, billingEnabled: true, confirmedPastDueDates: confirmation(before) }))
      .rejects.toMatchObject({ code: 'conflict' });
  });
  it('checks linked default cards, ignores revoked/non-default/expired cards, and checks current waiver families', async () => {
    const f = await fixture(); await f.makeMembership();
    const card = await factory('paymentMethods', f.gymId, { householdId: f.household.id, isDefault: false, expiryYear: 2030, expiryMonth: 1 });
    const waiver = await factory('waiverTemplates', f.gymId, { name: 'Participation' });
    let checklist = await f.service.checklist(f.gymId);
    expect(status(checklist, 'cards_collected')).toBe('needs_attention');
    expect(status(checklist, 'waivers_signed')).toBe('needs_attention');
    await factory('waiverSignatures', f.gymId, { templateId: waiver.id, memberId: f.member.id });
    await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ isDefault: true }).where(eq(paymentMethods.id, card.id)));
    checklist = await f.service.checklist(f.gymId);
    expect(status(checklist, 'cards_collected')).toBe('ready'); expect(status(checklist, 'waivers_signed')).toBe('ready');
    await factory('waiverTemplates', f.gymId, { name: waiver.name, version: 2 });
    expect(status(await f.service.checklist(f.gymId), 'waivers_signed')).toBe('needs_attention');
    await factory('waiverTemplates', f.gymId, { name: waiver.name, version: 3, retiredAt: f.clock.now() });
    expect(status(await f.service.checklist(f.gymId), 'waivers_signed')).toBe('not_applicable');
    for (const change of [{ expiryYear: 2026, expiryMonth: 9 }, { expiryYear: 2030, expiryMonth: 1, revokedAt: f.clock.now(), isDefault: false }]) {
      await db.forGym(f.gymId, tx => tx.update(paymentMethods).set(change).where(eq(paymentMethods.id, card.id)));
      expect(status(await f.service.checklist(f.gymId), 'cards_collected')).toBe('needs_attention');
    }
  });
  it('uses the real per-gym webhook accessor', async () => {
    const f = await fixture(), b = await fixture();
    await factory('stripeEvents', b.gymId, { processedAt: f.clock.now() });
    expect(status(await f.service.checklist(f.gymId), 'webhook_ready')).toBe('needs_attention');
    await factory('stripeEvents', f.gymId, { processedAt: f.clock.now() });
    expect(status(await f.service.checklist(f.gymId), 'webhook_ready')).toBe('ready');
    await factory('stripeEvents', f.gymId, { error: 'test' });
    expect(status(await f.service.checklist(f.gymId), 'webhook_ready')).toBe('needs_attention');
  });
  it('exposes the list and confirms billing through createApp with the production route registrations', async () => {
    const f = await fixture(), owner = await factory('authUser', f.gymId); await f.makeMembership({ nextDueOn: '2026-10-24' });
    configureGoLive({ scope: db.forGym, clock: f.clock, smtpConfigured: async () => true });
    const origin = 'https://gym.example.test';
    const app = createApp({ clock: f.clock, skipSetup: true, origin, authorize, contributions: areaContributions,
      resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'America/Vancouver', enabledModules: new Set() } }); await next(); },
      session: async (c, next) => { c.set('context', { ...c.get('context'), principal: { kind: 'staff', gymId: f.gymId, userId: owner.id, roles: ['owner'] } }); await next(); },
    });
    const read = await app.request(origin + '/api/settings/go-live'); expect(read.status).toBe(200);
    const data = goLiveChecklistResponseSchema.parse(await read.json()).data;
    const patch = (body: unknown) => app.request(origin + '/api/settings/go-live', { method: 'PATCH', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await patch({ revision: data.revision, billingEnabled: true })).status).toBe(409);
    const saved = await patch({ revision: data.revision, billingEnabled: true, confirmedPastDueDates: confirmation({ ...data, pastDueMemberships: data.pastDueMemberships ?? [] }) });
    expect(saved.status).toBe(200); expect(goLiveChecklistResponseSchema.parse(await saved.json()).data.billingEnabled).toBe(true);
    expect(updateGoLiveRequestSchema.safeParse({ revision: 1, confirmedPastDueDates: [] }).success).toBe(false);
    expect(updateGoLiveRequestSchema.safeParse({ revision: 1, billingEnabled: true, confirmedPastDueDates: true }).success).toBe(false);
    expect((await db.forGym(f.gymId, tx => tx.select().from(gyms).where(eq(gyms.id, f.gymId))))[0]!.billingEnabled).toBe(true);
  });
});
