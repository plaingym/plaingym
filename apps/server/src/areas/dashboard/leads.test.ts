// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { extensionDashboardWidgetSchema } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createFollowUpsDueProvider, followUpsDueWidgetId } from './leads.js';
import { createWidgetRegistry } from './widgets.js';

const db = useTestDatabase(), factory = createFactories(db);
// 23:30 on 9 March in New York is already 10 March in UTC.
const clock = new TestClock('2026-03-10T03:30:00Z');
const settings = createGymSettingsAccessor({ scope: db.forGym });
const provider = () => createFollowUpsDueProvider({ settings, scope: db.forGym });
async function gym(timezone = 'America/New_York') {
  const gymId = uuidv7();
  await factory('gyms', gymId, { timezone });
  return gymId;
}
async function lead(gymId: string, stage: string, nextFollowUpOn: string | null, overrides: Record<string, unknown> = {}) {
  const member = await factory('members', gymId, { status: 'prospect', ...overrides });
  await factory('leads', gymId, { memberId: member.id, stage, nextFollowUpOn,
    wonAt: stage === 'won' ? clock.now() : null, lostAt: stage === 'lost' ? clock.now() : null });
  return member;
}
const read = (gymId: string, roles: readonly StaffRole[] = ['front_desk']) => provider().read({ gymId, roles, clock });
const href = (memberId: string) => `/admin/leads/${memberId}`;

describe('follow-ups due dashboard tile', () => {
  it('counts open leads due on or before the gym\'s local today, soonest first, and skips tomorrow, won, lost and erased', async () => {
    const gymId = await gym();
    expect(await read(gymId)).toBeNull();
    const today = await lead(gymId, 'contacted', '2026-03-09', { firstName: 'Tess', lastName: 'Today' });
    const overdue = await lead(gymId, 'trial_attended', '2026-03-01', { firstName: 'Olly', lastName: 'Overdue' });
    const fresh = await lead(gymId, 'new', '2026-03-09', { firstName: 'Ned', lastName: 'New' });
    await lead(gymId, 'trial_booked', '2026-03-10');
    await lead(gymId, 'new', null);
    await lead(gymId, 'won', '2026-03-01', { status: 'active' });
    await lead(gymId, 'lost', '2026-03-01');
    await lead(gymId, 'contacted', '2026-03-01', { anonymizedAt: clock.now() });
    await factory('members', gymId, { status: 'prospect' });
    const widget = extensionDashboardWidgetSchema.parse(await read(gymId));
    expect(widget).toEqual({ id: followUpsDueWidgetId, titleKey: 'leads/screens:tile.title', status: 'ready', kind: 'count', count: 3,
      items: [{ label: 'Olly Overdue', href: href(overdue.id) }, { label: 'Ned New', href: href(fresh.id) }, { label: 'Tess Today', href: href(today.id) }] });
    // An hour later it is 10 March in New York too.
    expect(await provider().read({ gymId, roles: ['owner'], clock: new TestClock('2026-03-10T04:30:00Z') })).toMatchObject({ count: 4 });
  });
  it('lists at most 20 while counting every due lead, and never another gym\'s', async () => {
    const gymId = await gym(), other = await gym();
    for (let n = 0; n < 22; n++) await lead(gymId, 'new', '2026-03-0' + (1 + (n % 9)));
    await lead(other, 'new', '2026-03-01');
    const widget = extensionDashboardWidgetSchema.parse(await read(gymId));
    expect(widget.count).toBe(22); expect(widget.items).toHaveLength(20);
    expect((await read(other))?.count).toBe(1);
  });
  it.each(staffRoles)('shows for owners, admins and front desk and runs no read for a coach: %s', async role => {
    const gymId = await gym();
    await lead(gymId, 'new', '2026-03-09');
    const get = vi.fn(settings.get), opened = vi.fn();
    const scope: typeof db.forGym = (id, fn) => { opened(id); return db.forGym(id, fn); };
    const registry = createWidgetRegistry(extensionDashboardWidgetSchema);
    registry.register(createFollowUpsDueProvider({ settings: { get }, scope }));
    const widgets = await registry.read({ gymId, roles: [role], clock });
    if (role === 'coach') {
      expect(widgets).toEqual([]); expect(get).not.toHaveBeenCalled(); expect(opened).not.toHaveBeenCalled();
    } else expect(widgets.map(widget => widget.id)).toEqual([followUpsDueWidgetId]);
  });
  it('refuses a direct read without leads.manage', async () => {
    await expect(read(await gym(), ['coach'])).rejects.toMatchObject({ code: 'forbidden' });
  });
});
