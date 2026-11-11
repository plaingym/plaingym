// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, gt, isNull, lte } from 'drizzle-orm';
import { classCreditEntries, forGym, uuidv7 } from '@plaingym/db';
import { clock as defaultClock } from '../../../core/clock.js';
import type { JobRegistration } from '../../../core/registry.js';
import type { CatalogOptions } from '../catalog.js';
import { audit } from '../transitions/store.js';
import { lockMemberCredits, remainingLots } from './ledger.js';

export function createCreditExpiryService(options: CatalogOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return {
    async expire(gymId: string) {
      let cursor: string | undefined;
      const cutoff = clock.now();
      let expired = 0;
      for (;;) {
        const candidates = await scope(gymId, tx => tx.selectDistinct({ memberId: classCreditEntries.memberId })
          .from(classCreditEntries).where(and(isNull(classCreditEntries.lotId), lte(classCreditEntries.expiresAt, cutoff),
            cursor ? gt(classCreditEntries.memberId, cursor) : undefined))
          .orderBy(asc(classCreditEntries.memberId)).limit(100));
        if (!candidates.length) return expired;
        for (const { memberId } of candidates) {
          expired += await scope(gymId, async tx => {
            await lockMemberCredits(tx, memberId);
            const now = clock.now();
            const lots = (await remainingLots(tx, memberId)).filter(lot => lot.expiresAt !== null && lot.expiresAt <= now);
            let written = 0;
            for (const lot of lots) {
              const [entry] = await tx.insert(classCreditEntries).values({
                id: uuidv7(), gymId, memberId, kind: 'expire', lotId: lot.id, credits: -lot.remaining, createdAt: now,
              }).onConflictDoNothing().returning();
              if (!entry) continue;
              await audit(tx, { gymId, actor: { kind: 'system' } }, clock,
                'billing.credits.expired', 'class_credit_entry', entry.id, entry);
              written++;
            }
            return written;
          });
        }
        cursor = candidates.at(-1)!.memberId;
      }
    },
  };
}

export function createCreditExpiryJobs(options: CatalogOptions = {}): readonly JobRegistration[] {
  // The scheduler evaluates cron in each gym's timezone and supplies that gym's clock/context.
  return [{ id: 'billing.credits.expire', cron: '7 0 * * *', lane: 'batch', async handler(_payload, context) {
    await createCreditExpiryService({ ...options, clock: options.clock ?? context.clock }).expire(context.gymId);
  } }];
}
export const jobs = createCreditExpiryJobs();
