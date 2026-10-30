// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, exists, inArray, isNull } from 'drizzle-orm';
import type { z } from '@hono/zod-openapi';
import { forGym, households, members } from '@plaingym/db';
import { AppError, canStaff } from '@plaingym/shared';
import { extensionDashboardWidgetSchema } from '@plaingym/shared/contracts';
import type { DashboardWidgetProvider } from '../../core/interfaces/extensions.js';
import { awaitingConfirmationCondition } from './household-users.js';

export const portalConfirmationWidgetId = 'members.portal-confirmations';
const shown = 20;

/** Staff with portal access see the households whose join awaits portal confirmation (`awaitingConfirmation` in
 * `household-users.ts`), each linking to that household's Portal access tab. Password-mode installs have no mail to
 * tell them, so the dashboard does. With nothing waiting the widget has a zero count and no items, and the
 * dashboard then hides it. A household with no member left to open (all anonymized) has no tab and isn't listed. */
export function createPortalConfirmationWidgetProvider(options: { scope?: typeof forGym } = {}): DashboardWidgetProvider<z.infer<typeof extensionDashboardWidgetSchema>> {
  const scope = options.scope ?? forGym;
  return { id: portalConfirmationWidgetId, permission: 'portal_access.manage', order: 40, schema: extensionDashboardWidgetSchema,
    async read(context) {
      if (!canStaff(context.roles, 'portal_access.manage')) throw new AppError('forbidden', 'Access denied');
      return scope(context.gymId, async (tx) => {
        const waiting = and(awaitingConfirmationCondition(tx, context.gymId),
          exists(tx.select({ id: members.id }).from(members).where(and(eq(members.householdId, households.id), isNull(members.anonymizedAt)))));
        const count = await tx.$count(households, waiting);
        const rows = count ? await tx.select({ id: households.id, name: households.name }).from(households).where(waiting)
          .orderBy(asc(households.name), asc(households.id)).limit(shown) : [];
        const people = rows.length ? await tx.select({ id: members.id, householdId: members.householdId }).from(members)
          .where(and(inArray(members.householdId, rows.map(row => row.id)), isNull(members.anonymizedAt))).orderBy(asc(members.createdAt), asc(members.id)) : [];
        const first = new Map<string, string>();
        for (const member of people) if (!first.has(member.householdId)) first.set(member.householdId, member.id);
        const items = rows.flatMap((row) => {
          const person = first.get(row.id);
          return person ? [{ label: row.name, href: `/admin/members/${person}#memberTabs.portal-access` }] : [];
        });
        return { id: portalConfirmationWidgetId, titleKey: 'portal/access:waitingTitle', status: 'ready' as const, kind: 'count' as const, count, items };
      });
    },
  };
}
