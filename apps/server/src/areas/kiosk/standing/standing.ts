// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray } from 'drizzle-orm';
import { forGym, members, waiverSignatures, waiverTemplates } from '@plaingym/db';
import type { KioskStandingCheck, StandingContext } from '../../../core/interfaces/extensions.js';

/** Statuses that may check in; prospects, frozen and cancelled members see the front desk. */
const activeStatuses = new Set(['active', 'trial', 'visitor']);
export function inactiveStanding(scope: typeof forGym = forGym): KioskStandingCheck {
  return { id: 'inactive', async check(context) {
    const [row] = await scope(context.gymId, (tx) => tx.select({ status: members.status, anonymizedAt: members.anonymizedAt })
      .from(members).where(eq(members.id, context.memberId)));
    return row && !row.anonymizedAt && activeStatuses.has(row.status) ? { status: 'ok' } : { status: 'front_desk', reasonCode: 'inactive' };
  } };
}
/** Every current waiver (each family's latest version, unless that version is retired) must be signed.
 * Agreements belong to memberships and are checked by billing. */
export function waiverStanding(scope: typeof forGym = forGym): KioskStandingCheck {
  return { id: 'missing_waiver', async check(context) {
    const missing = await scope(context.gymId, async (tx) => {
      const templates = await tx.select({ id: waiverTemplates.id, name: waiverTemplates.name, version: waiverTemplates.version, retiredAt: waiverTemplates.retiredAt })
        .from(waiverTemplates).where(eq(waiverTemplates.kind, 'waiver'));
      const latest = new Map<string, (typeof templates)[number]>();
      for (const template of templates) if ((latest.get(template.name)?.version ?? 0) < template.version) latest.set(template.name, template);
      const required = [...latest.values()].filter((template) => !template.retiredAt).map((template) => template.id);
      if (!required.length) return false;
      const signed = await tx.select({ templateId: waiverSignatures.templateId }).from(waiverSignatures)
        .where(and(eq(waiverSignatures.memberId, context.memberId), inArray(waiverSignatures.templateId, required)));
      return new Set(signed.map((row) => row.templateId)).size < required.length;
    });
    return missing ? { status: 'front_desk', reasonCode: 'missing_waiver' } : { status: 'ok' };
  } };
}

export interface MemberStanding { readonly status: 'ok' | 'front_desk'; readonly reasons: readonly string[]; }
/** Runs every standing check; any failure sends the member to the front desk. Reasons are for staff only. */
export function createStandingChecks(checks: readonly KioskStandingCheck[]) {
  return {
    async evaluate(context: StandingContext): Promise<MemberStanding> {
      // Provider failures must not disclose their messages or allow an unchecked visit.
      const results = await Promise.all(checks.map(async (check) => {
        try { return await check.check(context); }
        catch { return { status: 'front_desk', reasonCode: 'unavailable' } as const; }
      }));
      const reasons = results.flatMap((result) => result.status === 'front_desk' ? [result.reasonCode] : []);
      return { status: reasons.length ? 'front_desk' : 'ok', reasons };
    },
  };
}
export type StandingChecks = ReturnType<typeof createStandingChecks>;
