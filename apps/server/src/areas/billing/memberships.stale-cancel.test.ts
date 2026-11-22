// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { auditEvents, memberships, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError } from '@plaingym/shared';
import { TestClock } from '../../core/clock.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createMembershipService } from './memberships.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2028-03-10T12:00:00Z');
  await factory('gyms', gymId, { currency: 'CAD', timezone: 'America/Vancouver' });
  const home = await factory('households', gymId, { billingDay: 1 });
  const member = await factory('members', gymId, { householdId: home.id, status: 'active' });
  const plan = await factory('plans', gymId), next = await factory('plans', gymId, { name: 'Premium', amountCents: 12000 });
  const row = await factory('memberships', gymId, { householdId: home.id, memberId: member.id, planId: plan.id,
    status: 'active', startsOn: '2028-03-01', nextDueOn: '2028-04-01', revision: 3,
    scheduledPlanId: next.id, scheduledAmountCents: next.amountCents, scheduledInterval: 'monthly', scheduledOn: '2028-04-01' });
  await factory('auditEvents', gymId, { action: 'billing.membership.assigned', targetType: 'membership',
    targetId: row.id, occurredAt: clock.now() });
  const service = createMembershipService({ scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) });
  const read = async () => {
    const [membership] = await db.forGym(gymId, tx => tx.select().from(memberships).where(eq(memberships.id, row.id)));
    if (!membership) throw new Error('Membership not found');
    return membership;
  };
  const audits = () => db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, row.id))
    .orderBy(asc(auditEvents.id)));
  return { gymId, context: { gymId, actor: { kind: 'system' as const } }, service, row, read, audits };
}
describe('stale cancellation revisions against PostgreSQL', () => {
  it.each(['cancel', 'cancelScheduledSwitch'] as const)(
    '%s refuses a revision one below the row and changes neither the row nor its audits', async action => {
      const f = await fixture(), before = await f.read(), auditsBefore = await f.audits();
      const error = await f.service[action](f.context, { membershipId: f.row.id, revision: before.revision - 1 })
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'conflict', details: { reason: ['membership_changed'] } });
      expect(await f.read()).toEqual(before);
      expect(await f.audits()).toEqual(auditsBefore);
    });
});
