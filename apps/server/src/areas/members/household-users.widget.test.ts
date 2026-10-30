// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { householdUsers, households, members, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles } from '@plaingym/shared';
import { matDashboardResponseSchema } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import { areaContributions } from '../../core/registry-areas.js';
import { createApp } from '../../app.js';
import { createAttendanceQueries } from '../attendance/attendance.js';
import { configureDashboard } from '../dashboard/dashboard.routes.js';
import { createPromotionCriteria } from '../ranks/criteria.js';
import { createRanksService } from '../ranks/ranks.service.js';
import { authorize } from '../staff/auth.permissions.js';
import { createMembersService } from './members.js';
import { requestPortalConfirmation } from './household-users.js';
import { createPortalConfirmationWidgetProvider, portalConfirmationWidgetId } from './household-users.widget.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-10-30T12:00:00Z');
const provider = () => createPortalConfirmationWidgetProvider({ scope: database.forGym });
const href = (memberId: string) => `/admin/members/${memberId}#memberTabs.portal-access`;

async function gym() {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  return gymId;
}
/** A household whose password-mode join awaits staff confirmation, with its first member. */
async function waiting(gymId: string, name: string, overrides: { email?: string | null } = {}) {
  const home = await factory('households', gymId, { name, email: 'email' in overrides ? overrides.email : `${uuidv7()}@example.invalid` });
  const member = await factory('members', gymId, { householdId: home.id });
  await database.forGym(gymId, (tx) => requestPortalConfirmation(tx, gymId, home.id, clock));
  return { home, member };
}
const read = (gymId: string, roles: readonly (typeof staffRoles)[number][] = ['owner']) => provider().read({ gymId, roles, clock });

describe('portal confirmation widget', () => {
  it('lists households awaiting confirmation with a link to each one\'s Portal access tab, and nothing when none wait', async () => {
    const gymId = await gym();
    expect(await read(gymId)).toEqual({ id: portalConfirmationWidgetId, titleKey: 'portal/access:waitingTitle', status: 'ready', kind: 'count', count: 0, items: [] });
    const b = await waiting(gymId, 'Brown household'), a = await waiting(gymId, 'Adams household');
    // A second, later member never changes the link: it opens the household's first member.
    await factory('members', gymId, { householdId: a.home.id });
    expect(await read(gymId)).toEqual({ id: portalConfirmationWidgetId, titleKey: 'portal/access:waitingTitle', status: 'ready', kind: 'count', count: 2,
      items: [{ label: 'Adams household', href: href(a.member.id) }, { label: 'Brown household', href: href(b.member.id) }] });
  });

  it('stops listing a household once it has a payer login; a member-only login or an invitation keeps it waiting', async () => {
    const gymId = await gym(), joined = await waiting(gymId, 'Joined household');
    await factory('householdUsers', gymId, { householdId: joined.home.id, scope: 'member', memberId: joined.member.id });
    await database.forGym(gymId, (tx) => writeAudit(tx, { gymId, actorKind: 'system', action: 'household_user.invited', targetType: 'household', targetId: joined.home.id, occurredAt: clock.now() }));
    expect(await read(gymId)).toHaveProperty('count', 1);
    const payer = await factory('householdUsers', gymId, { householdId: joined.home.id, scope: 'payer', memberId: null });
    expect(await read(gymId)).toMatchObject({ count: 0, items: [] });
    // Revoking the payer login offers confirmation again, as the household's Portal access tab does.
    await database.forGym(gymId, (tx) => tx.delete(householdUsers).where(eq(householdUsers.id, payer.id)));
    expect(await read(gymId)).toHaveProperty('count', 1);
  });

  it('skips households without an address or a member to open, and households that never asked for confirmation', async () => {
    const gymId = await gym();
    await waiting(gymId, 'Erased household', { email: null });
    const anonymized = await waiting(gymId, 'Anonymized household');
    await database.forGym(gymId, (tx) => tx.update(members).set({ anonymizedAt: clock.now() }).where(eq(members.id, anonymized.member.id)));
    const plain = await factory('households', gymId, { email: 'plain@example.invalid' });
    await factory('members', gymId, { householdId: plain.id });
    const visible = await waiting(gymId, 'Visible household');
    expect(await read(gymId)).toMatchObject({ count: 1, items: [{ label: 'Visible household', href: href(visible.member.id) }] });
  });

  it('caps the shortlist at twenty and still counts every household', async () => {
    const gymId = await gym();
    for (let index = 0; index < 22; index++) await waiting(gymId, `Household ${String(index).padStart(2, '0')}`);
    const widget = await read(gymId);
    expect(widget).toHaveProperty('count', 22);
    expect(widget.items).toHaveLength(20);
    expect(widget.items?.[0]?.label).toBe('Household 00');
    expect(provider().schema.parse(widget)).toEqual(widget);
  });

  it('counts only its own gym and shows it only to staff with portal access', async () => {
    const gymId = await gym(), other = await gym();
    await waiting(gymId, 'Mine');
    await waiting(other, 'Theirs'); await waiting(other, 'Theirs too');
    expect(await read(gymId)).toMatchObject({ count: 1, items: [{ label: 'Mine' }] });
    expect(await read(other)).toHaveProperty('count', 2);
    for (const role of staffRoles) {
      if (role === 'coach') await expect(read(gymId, [role])).rejects.toMatchObject({ code: 'forbidden' });
      else await expect(read(gymId, [role])).resolves.toHaveProperty('count', 1);
    }
    expect(await database.forGym(gymId, (tx) => tx.select({ id: households.id }).from(households))).toHaveLength(1);
  });

  it('reaches the dashboard through createApp for staff with portal access only, and carries no email address', async () => {
    const gymId = await gym(), foreign = await gym(), joined = await waiting(gymId, 'Joined household');
    await waiting(foreign, 'Foreign household');
    const widget = provider(), spy = vi.spyOn(widget, 'read');
    const attendance = createAttendanceQueries({ scope: database.forGym, clock });
    configureDashboard({ members: createMembersService({ scope: database.forGym, clock }),
      ranks: createRanksService({ scope: database.forGym, clock, criteria: createPromotionCriteria(attendance) }), attendance }, [widget]);
    const user = await factory('authUser', gymId);
    let principal: Principal = { kind: 'anonymous' };
    const app = createApp({ contributions: areaContributions, clock, authorize, setupToken: 'test-setup-token',
      resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
      session: async (c, next) => { c.set('context', { ...c.get('context'), principal }); await next(); } });
    for (const role of staffRoles) {
      spy.mockClear(); principal = { kind: 'staff', gymId, userId: user.id, roles: [role] };
      const response = await app.request('/api/dashboard');
      expect(response.status).toBe(200);
      const text = await response.text(), { data } = matDashboardResponseSchema.parse(JSON.parse(text));
      const found = data.widgets.find((entry) => entry.id === portalConfirmationWidgetId);
      if (role === 'coach') { expect(found).toBeUndefined(); expect(spy).not.toHaveBeenCalled(); }
      else expect(found).toMatchObject({ count: 1, items: [{ label: 'Joined household', href: href(joined.member.id) }] });
      expect(text).not.toContain('example.invalid');
    }
  });
});
