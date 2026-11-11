// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, exists, inArray, isNull, lte } from 'drizzle-orm';
import type { z } from '@hono/zod-openapi';
import { forGym, leads, members } from '@plaingym/db';
import { AppError, canStaff } from '@plaingym/shared';
import { extensionDashboardWidgetSchema } from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import type { DashboardWidgetProvider } from '../../core/interfaces/extensions.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';

export const followUpsDueWidgetId = 'leads.follow-ups-due';
const shown = 20;
const open = ['new', 'contacted', 'trial_booked', 'trial_attended'];

/** Open leads (not won, lost or erased) whose next follow-up falls on or before the gym's local today, soonest first,
 * each linking to its lead page. Only staff with `leads.manage` run its reads; with nothing due it returns null.
 * After the settings read for the timezone, one statement in one gym scope finds the shortlist and counts every due
 * lead (a scalar subquery). */
export function createFollowUpsDueProvider(options: { settings: Pick<GymSettingsAccessor, 'get'>; scope?: typeof forGym }):
DashboardWidgetProvider<z.infer<typeof extensionDashboardWidgetSchema>> {
  const scope = options.scope ?? forGym;
  return { id: followUpsDueWidgetId, permission: 'leads.manage', order: 50, schema: extensionDashboardWidgetSchema,
    async read(context) {
      if (!canStaff(context.roles, 'leads.manage')) throw new AppError('forbidden', 'Access denied');
      const today = localDate(context.clock.now(), (await options.settings.get(context.gymId)).timezone);
      const person = and(eq(members.gymId, leads.gymId), eq(members.id, leads.memberId));
      const rows = await scope(context.gymId, tx => {
        const due = and(inArray(leads.stage, open), lte(leads.nextFollowUpOn, today),
          exists(tx.select({ id: members.id }).from(members).where(and(person, isNull(members.anonymizedAt)))));
        // In the count's subquery, `leads` names that subquery's own row, so the member check follows each counted lead.
        const total = tx.$count(leads, due);
        return tx.select({ memberId: members.id, firstName: members.firstName, lastName: members.lastName, total })
          .from(leads).innerJoin(members, person).where(due)
          .orderBy(asc(leads.nextFollowUpOn), asc(members.lastName), asc(members.firstName), asc(members.id)).limit(shown);
      });
      const count = rows[0]?.total ?? 0;
      if (!count) return null;
      return { id: followUpsDueWidgetId, titleKey: 'leads/screens:tile.title', status: 'ready' as const, kind: 'count' as const,
        count, items: rows.map(row => ({ label: (`${row.firstName} ${row.lastName}`.trim() || row.memberId).slice(0, 200),
          href: `/admin/leads/${row.memberId}` })) };
    },
  };
}
