// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { billingDashboardWidgetSchema, extensionDashboardWidgetSchema, matDashboardWidgetSchema } from '@plaingym/shared/contracts';
import { FakeDashboardWidgetProvider } from '../../core/interfaces/extensions.js';
import { TestClock } from '../../core/clock.js';
import { createWidgetRegistry } from './widgets.js';
import { createBillingWidgetRegistry } from './billing.js';

const clock = new TestClock('2026-10-22T12:00:00Z');
const gymId = '01900000-0000-7000-8000-000000000001';
const otherGym = '01900000-0000-7000-8000-000000000002';
const context = { gymId, roles: ['owner'] as const, clock };
describe('dashboard provider registry', () => {
  it('reads class-based frozen fakes with private state and keeps gyms isolated', async () => {
    const provider = new FakeDashboardWidgetProvider('active_members', 'members.read', matDashboardWidgetSchema);
    provider.set(gymId, { id: 'active_members', titleKey: 'active', status: 'ready', count: 3 });
    provider.set(otherGym, { id: 'active_members', titleKey: 'active', status: 'ready', count: 9 });
    const registry = createWidgetRegistry(matDashboardWidgetSchema); registry.register(provider);
    expect(await registry.read(context)).toEqual([{ id: 'active_members', titleKey: 'active', status: 'ready', count: 3 }]);
    expect((await registry.read({ ...context, gymId: otherGym }))[0]).toHaveProperty('count', 9);
  });
  it('does not invoke unauthorized or disabled-module providers', async () => {
    const registry = createWidgetRegistry(extensionDashboardWidgetSchema);
    const read = vi.fn(async () => ({ id: 'test.metric', kind: 'count' as const, count: 1, titleKey: 'metric', status: 'ready' as const }));
    registry.register({ id: 'test.metric', moduleId: 'test', permission: 'promotions.manage', schema: extensionDashboardWidgetSchema, read });
    expect(await registry.read(context)).toEqual([]);
    expect(await registry.read({ ...context, roles: ['front_desk'], enabledModules: new Set(['test']) })).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(await registry.read({ ...context, enabledModules: new Set(['test']) })).toHaveLength(1);
  });
  it('rejects duplicate registrations and mismatched IDs or schemas', async () => {
    const registry = createWidgetRegistry(extensionDashboardWidgetSchema);
    const provider = { id: 'test.one', permission: 'members.read' as const, schema: extensionDashboardWidgetSchema,
      read: async () => ({ id: 'test.two', kind: 'count' as const, count: 1, titleKey: 'test', status: 'ready' as const }) };
    registry.register(provider);
    expect(() => registry.register(provider)).toThrow(/Duplicate/);
    await expect(registry.read(context)).rejects.toThrow('Invalid dashboard widget');
    const invalid = createWidgetRegistry(extensionDashboardWidgetSchema);
    invalid.register({ ...provider, read: async () => ({ id: 'test.one', kind: 'count', count: -1, titleKey: 'test', status: 'ready' }) });
    await expect(invalid.read(context)).rejects.toThrow();
  });
  it('accepts billing providers through the same registry with no framework changes', async () => {
    const registry = createBillingWidgetRegistry();
    expect(await registry.read(context)).toEqual([]);
    const read = vi.fn(async () => ({ id: 'mrr' as const, titleKey: 'billing', status: 'ready' as const,
      money: { currency: 'USD', amountCents: 25000 } }));
    registry.register({ id: 'mrr', permission: 'billing.read', schema: billingDashboardWidgetSchema, read });
    expect(await registry.read({ ...context, roles: ['coach'] })).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect((await registry.read(context))[0]).toHaveProperty('money.amountCents', 25000);
  });
});
