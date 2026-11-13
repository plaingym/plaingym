// SPDX-License-Identifier: AGPL-3.0-only
import type { KioskStandingCheck } from '../../core/interfaces/extensions.js';
import { and, eq } from 'drizzle-orm';
import { forGym, invoices, members } from '@plaingym/db';
import { localDate } from '@plaingym/shared/time';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { overdueInvoiceCondition } from './kiosk-standing.rules.js';
import { lacksClassEligibility } from './packs/index.js';

/** Household debt affects standing; reasons stay internal to staff. */
export function createBillingStanding(scope: typeof forGym = forGym): KioskStandingCheck {
  const settings = createGymSettingsAccessor({ scope });
  return { id: 'billing', async check(context) {
    const gym = await settings.get(context.gymId), today = localDate(context.clock.now(), gym.timezone);
    return scope(context.gymId, async tx => {
      const [member] = await tx.select({ householdId: members.householdId }).from(members).where(eq(members.id, context.memberId));
      if (!member) return { status: 'front_desk', reasonCode: 'unavailable' };
      const [overdue] = await tx.select({ id: invoices.id }).from(invoices).where(and(
        eq(invoices.householdId, member.householdId), overdueInvoiceCondition(today))).limit(1);
      if (overdue) return { status: 'front_desk', reasonCode: 'past_due' };
      return { status: 'ok' };
    });
  } };
}

/** Independent of billing so staff see both credit and overdue-invoice problems together. */
export function createCreditsStanding(scope: typeof forGym = forGym): KioskStandingCheck {
  return { id: 'credits', check: context => scope(context.gymId, async tx =>
    await lacksClassEligibility(tx, context.memberId, context.clock.now())
      ? { status: 'front_desk', reasonCode: 'no_credits' } : { status: 'ok' }) };
}
