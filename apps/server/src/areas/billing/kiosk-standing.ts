// SPDX-License-Identifier: AGPL-3.0-only
import type { KioskStandingCheck } from '../../core/interfaces/extensions.js';
import { and, eq } from 'drizzle-orm';
import { forGym, invoices, members } from '@plaingym/db';
import { localDate } from '@plaingym/shared/time';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { overdueInvoiceCondition } from './kiosk-standing.rules.js';

/** Household debt affects every member; only a neutral internal standing leaves this query. */
export function createBillingStanding(scope: typeof forGym = forGym): KioskStandingCheck {
  const settings = createGymSettingsAccessor({ scope });
  return { id: 'billing', async check(context) {
    const gym = await settings.get(context.gymId), today = localDate(context.clock.now(), gym.timezone);
    return scope(context.gymId, async tx => {
      const [member] = await tx.select({ householdId: members.householdId }).from(members).where(eq(members.id, context.memberId));
      if (!member) return { status: 'front_desk', reasonCode: 'unavailable' };
      const [overdue] = await tx.select({ id: invoices.id }).from(invoices).where(and(
        eq(invoices.householdId, member.householdId), overdueInvoiceCondition(today))).limit(1);
      return overdue ? { status: 'front_desk', reasonCode: 'past_due' } : { status: 'ok' };
    });
  } };
}
