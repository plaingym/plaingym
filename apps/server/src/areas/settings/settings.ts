// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { forGym, gyms, plans, chargeTypes, memberships, invoices, revisionGuard, assertRevised, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { gymSettingsSchema, updateGymSettingsRequestSchema, updateBookingRulesRequestSchema, updateGymCurrencyRequestSchema,
  type UpdateGymSettingsRequest, type UpdateBookingRulesRequest, type UpdateGymCurrencyRequest } from '@plaingym/shared/contracts';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { clock as defaultClock } from '../../core/clock.js';
/** Select the public fields at the database boundary; opaque config never reaches a response or audit. */
const projection = {
  id: gyms.id, name: gyms.name, slug: gyms.slug, timezone: gyms.timezone, address: gyms.address, branding: gyms.branding,
  websiteEnabled: gyms.websiteEnabled, existingSiteUrl: gyms.existingSiteUrl, currency: gyms.currency,
  bookingWindowDays: gyms.bookingWindowDays, cancellationCutoffMinutes: gyms.cancellationCutoffMinutes,
  billingEnabled: gyms.billingEnabled, memberEmailsEnabled: gyms.memberEmailsEnabled,
  revision: gyms.revision, createdAt: gyms.createdAt, updatedAt: gyms.updatedAt,
};
type Row = { createdAt: Date; updatedAt: Date } & Record<string, unknown>;
const present = (row: Row) => gymSettingsSchema.parse({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
export function createSettingsService(options: { scope?: typeof forGym; clock?: Clock } = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return {
    async get(gymId: string) {
      return scope(gymId, async (tx) => {
        const [row] = await tx.select(projection).from(gyms).where(eq(gyms.id, gymId));
        if (!row) throw new AppError('not_found', 'Gym not found');
        return present(row);
      });
    },
    async update(context: MutationContext, kind: 'general' | 'booking' | 'currency', input: UpdateGymSettingsRequest | UpdateBookingRulesRequest | UpdateGymCurrencyRequest) {
      const schema = kind === 'general' ? updateGymSettingsRequestSchema : kind === 'booking' ? updateBookingRulesRequestSchema : updateGymCurrencyRequestSchema;
      const { revision, ...changes } = schema.parse(input);
      try {
        return await scope(context.gymId, async (tx) => {
          const [before] = await tx.select(projection).from(gyms).where(eq(gyms.id, context.gymId)).for('update');
          if (!before) throw new AppError('not_found', 'Gym not found');
          if (kind === 'currency' && 'currency' in changes && changes.currency !== before.currency) {
            for (const table of [plans, chargeTypes, memberships, invoices]) {
              const existing = await tx.select({ id: table.id }).from(table).where(eq(table.gymId, context.gymId)).limit(1);
              if (existing.length) throw new AppError('conflict', 'Currency cannot change after billing records exist');
            }
          }
          const guard = revisionGuard(gyms.revision, revision);
          const after = assertRevised(await tx.update(gyms).set({ ...changes, revision: guard.next, updatedAt: clock.now() })
            .where(and(eq(gyms.id, context.gymId), guard.matches)).returning(projection));
          await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
            ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
            action: 'settings.' + kind + '.updated', targetType: 'gym', targetId: context.gymId,
            before: present(before), after: present(after), occurredAt: clock.now() });
          return present(after);
        });
      } catch (error) {
        // A concurrent billing insert is also protected by the database currency foreign keys.
        if (error instanceof Error && 'cause' in error && typeof error.cause === 'object' && error.cause !== null && 'code' in error.cause && error.cause.code === '23503')
          throw new AppError('conflict', 'Currency cannot change after billing records exist');
        throw error;
      }
    },
  };
}
export function createGymSettingsAccessor(options: Parameters<typeof createSettingsService>[0] = {}): GymSettingsAccessor {
  const service = createSettingsService(options);
  return { async get(gymId) {
    const value = await service.get(gymId);
    return { gymId: value.id, timezone: value.timezone, currency: value.currency,
      billingEnabled: value.billingEnabled, memberEmailsEnabled: value.memberEmailsEnabled, websiteEnabled: value.websiteEnabled,
      bookingWindowDays: value.bookingWindowDays, cancellationCutoffMinutes: value.cancellationCutoffMinutes, revision: value.revision };
  } };
}
export const gymSettingsAccessor = createGymSettingsAccessor();
