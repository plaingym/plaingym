// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { Registry } from '@plaingym/shared';
import { instantSchema, moneySchema } from '@plaingym/shared/contracts';
import { FakeDashboardWidgetProvider, FakeHealthTileProvider, FakeKioskStandingCheck, FakePromotionCriterionProvider } from './extensions.js';
import type { HealthTileProvider } from './extensions.js';
import { clock, gym, otherGym, member, id } from './test-fixtures.js';
const criterionContext = { attendanceScope: { kind: 'gym' as const, gymId: gym }, gymId: gym, memberId: member, programId: id(10), rankId: id(11), promotedAt: null, dateOfBirth: null, timezone: 'UTC', clock: clock() };
const staff = () => ({ gymId: gym, roles: ['owner'] as const, clock: clock() });
// Representative wire shapes: provider payloads retain their injected contract's exact type.
const mrrSchema = z.strictObject({ id: z.literal('mrr'), titleKey: z.string(),
  status: z.enum(['ready', 'not_configured', 'unavailable']), money: moneySchema });
const jobsTileSchema = z.strictObject({ id: z.literal('failed_jobs'),
  status: z.enum(['healthy', 'warning', 'error', 'not_configured', 'unavailable']),
  message: z.string(), checkedAt: instantSchema.nullable(), details: z.strictObject({ failed: z.int().nonnegative() }).nullable() });
describe('Extension provider fakes', () => {
  it('validates criterion config and computes progress within the member, program, rank and promotion scope', async () => {
    const fake = new FakePromotionCriterionProvider('classes', 'ranks.classes');
    fake.setProgress(criterionContext, 84);
    expect(await fake.evaluate(criterionContext, { target: 100 })).toEqual({ current: 84, target: 100, met: false });
    expect((await fake.evaluate(criterionContext, { target: 80 })).met).toBe(true);
    expect((await fake.evaluate({ ...criterionContext, gymId: otherGym }, { target: 100 })).current).toBe(0);
    expect((await fake.evaluate({ ...criterionContext, rankId: id(99) }, { target: 100 })).current).toBe(0);
    expect((await fake.evaluate({ ...criterionContext, promotedAt: '2026-10-21T12:00:00Z' }, { target: 100 })).current).toBe(0);
    await expect(fake.evaluate(criterionContext, { target: -1 })).rejects.toThrow();
  });
  it('keeps standing reasons internal and does not share them between gyms', async () => {
    const fake = new FakeKioskStandingCheck('billing');
    fake.set(gym, member, { status: 'front_desk', reasonCode: 'past_due' });
    expect(await fake.check({ gymId: gym, memberId: member, clock: clock() })).toEqual({ status: 'front_desk', reasonCode: 'past_due' });
    expect(await fake.check({ gymId: otherGym, memberId: member, clock: clock() })).toEqual({ status: 'ok' });
  });
  it('protects billing widgets with frozen permissions, while preserving and validating their wire payload', async () => {
    const fake = new FakeDashboardWidgetProvider('mrr', 'billing.read', mrrSchema);
    const widget = { id: 'mrr' as const, titleKey: 'dashboard.mrr', status: 'ready' as const, money: { amountCents: 10000, currency: 'CAD' } };
    fake.set(gym, widget);
    expect((await fake.read(staff())).money).toEqual({ amountCents: 10000, currency: 'CAD' });
    widget.money.amountCents = 1;
    expect((await fake.read(staff())).money.amountCents).toBe(10000);
    await expect(fake.read({ ...staff(), roles: ['coach'] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(fake.read({ ...staff(), gymId: otherGym })).rejects.toMatchObject({ code: 'not_found' });
    expect(() => fake.set(gym, { ...widget, money: { amountCents: 1, currency: 'cad' } })).toThrow();
  });
  it('validates health data against its tile contract with an injected clock and manager permission', async () => {
    const fake = new FakeHealthTileProvider('failed_jobs', jobsTileSchema);
    fake.set(gym, { id: 'failed_jobs', status: 'warning', message: 'Failed jobs', details: { failed: 2 } });
    const context = staff();
    expect(await fake.read(context)).toMatchObject({ status: 'warning', checkedAt: '2026-10-21T12:00:00.000Z', details: { failed: 2 } });
    context.clock.advance(1000);
    expect((await fake.read(context)).checkedAt).toBe('2026-10-21T12:00:01.000Z');
    await expect(fake.read({ ...staff(), gymId: otherGym })).rejects.toMatchObject({ code: 'not_found' });
    await expect(fake.read({ ...staff(), roles: ['front_desk'] })).rejects.toMatchObject({ code: 'not_found' });
    fake.set(gym, { id: 'failed_jobs', status: 'warning', message: 'Invalid count', details: { failed: -1 } });
    await expect(fake.read(staff())).rejects.toThrow();
  });
  it('fits the module-aware registry without importing feature code into core', () => {
    const registry = new Registry<HealthTileProvider>();
    const core = new FakeHealthTileProvider('failed_jobs', jobsTileSchema);
    const optionalSchema = jobsTileSchema.extend({ id: z.literal('version') });
    const optional = new FakeHealthTileProvider('version', optionalSchema);
    registry.register(core);
    registry.register({ id: optional.id, moduleId: 'test-module', permission: optional.permission,
      schema: optional.schema, read: (context) => optional.read(context) });
    expect(registry.forModules(new Set()).map((provider) => provider.id)).toEqual(['failed_jobs']);
    expect(registry.forModules(new Set(['test-module']))).toHaveLength(2);
  });
});
