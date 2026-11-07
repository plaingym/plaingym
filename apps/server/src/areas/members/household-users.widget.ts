// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, exists, inArray, isNull, not } from 'drizzle-orm';
import type { z } from '@hono/zod-openapi';
import { forGym, households, members } from '@plaingym/db';
import { AppError, canStaff } from '@plaingym/shared';
import { extensionDashboardWidgetSchema } from '@plaingym/shared/contracts';
import type { DashboardWidgetProvider } from '../../core/interfaces/extensions.js';
import { createPortalInvitationStore, type PortalInvitationStore } from '../../infra/auth/portal-invitations.js';
import { awaitingConfirmationCondition } from './household-users.js';

export const portalConfirmationWidgetId = 'members.portal-confirmations';
const shown = 20;

/** Staff with portal access see the households whose join awaits portal confirmation (`awaitingConfirmation` in
 * `household-users.ts`), each linking to that household's Portal access tab. Password-mode installs have no mail to
 * tell them, so the dashboard does. With nothing waiting the provider returns null.
 * A household with no member left to open (all anonymized) has no tab and isn't listed, and nor
 * is one whose payer invitation is outstanding: staff have acted, and it returns if that invitation is revoked or expires
 * (its tab still shows the invitation). One query on the authentication pool finds and counts the shortlist (the invitations
 * live there), and a second, on the app pool, picks each one's member. */
export function createPortalConfirmationWidgetProvider(options: { scope?: typeof forGym; invitations?: Pick<PortalInvitationStore, 'withPayerInvitations'> } = {}):
DashboardWidgetProvider<z.infer<typeof extensionDashboardWidgetSchema>> {
  const scope = options.scope ?? forGym, invitations = options.invitations ?? createPortalInvitationStore();
  return { id: portalConfirmationWidgetId, permission: 'portal_access.manage', order: 40, schema: extensionDashboardWidgetSchema,
    async read(context) {
      if (!canStaff(context.roles, 'portal_access.manage')) throw new AppError('forbidden', 'Access denied');
      const rows = await invitations.withPayerInvitations(context.gymId, context.clock, (tx, payerInvited) => {
        const waiting = and(awaitingConfirmationCondition(tx, context.gymId), not(payerInvited(households.id)),
          exists(tx.select({ id: members.id }).from(members).where(and(eq(members.householdId, households.id), isNull(members.anonymizedAt)))));
        // The count is a scalar subquery of the same statement, so it covers every waiting household, not just the page.
        return tx.select({ id: households.id, name: households.name, count: tx.$count(households, waiting) })
          .from(households).where(waiting).orderBy(asc(households.name), asc(households.id)).limit(shown);
      });
      const count = rows[0]?.count ?? 0;
      if (!count) return null;
      // A household whose last member was anonymized since is skipped, as its tab is gone.
      const people = await scope(context.gymId, tx => tx.select({ id: members.id, householdId: members.householdId }).from(members)
        .where(and(inArray(members.householdId, rows.map(row => row.id)), isNull(members.anonymizedAt))).orderBy(asc(members.createdAt), asc(members.id)));
      const first = new Map<string, string>();
      for (const member of people) if (!first.has(member.householdId)) first.set(member.householdId, member.id);
      const items = rows.flatMap((row) => {
        const person = first.get(row.id);
        return person ? [{ label: row.name, href: `/admin/members/${person}#memberTabs.portal-access` }] : [];
      });
      return { id: portalConfirmationWidgetId, titleKey: 'portal/access:waitingTitle', status: 'ready' as const, kind: 'count' as const, count, items };
    },
  };
}
