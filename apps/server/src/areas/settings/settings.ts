// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { databaseCode, forGym, gyms, plans, chargeTypes, memberships, invoices, revisionGuard, assertRevised, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { billingRulesSchema, gymSettingsSchema, updateGymSettingsRequestSchema, updateBookingRulesRequestSchema, updateBillingRulesRequestSchema, updateGymCurrencyRequestSchema,
  updateDropInSettingsRequestSchema, type UpdateGymSettingsRequest, type UpdateBookingRulesRequest, type UpdateBillingRulesRequest, type UpdateGymCurrencyRequest,
  type UpdateDropInSettingsRequest } from '@plaingym/shared/contracts';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { clock as defaultClock } from '../../core/clock.js';
/** Select the public fields at the database boundary; opaque config never reaches a response or audit. */
const projection = {
  id: gyms.id, name: gyms.name, slug: gyms.slug, timezone: gyms.timezone, address: gyms.address, branding: gyms.branding,
  websiteEnabled: gyms.websiteEnabled, existingSiteUrl: gyms.existingSiteUrl, currency: gyms.currency,
  bookingWindowDays: gyms.bookingWindowDays, cancellationCutoffMinutes: gyms.cancellationCutoffMinutes,
  openMatCountsAsClass: gyms.openMatCountsAsClass,
  billingEnabled: gyms.billingEnabled, memberEmailsEnabled: gyms.memberEmailsEnabled,
  retryDays: gyms.retryDays, dropInChargeTypeId: gyms.dropInChargeTypeId,
  revision: gyms.revision, createdAt: gyms.createdAt, updatedAt: gyms.updatedAt,
};
type Row = { createdAt: Date; updatedAt: Date } & Record<string, unknown>;
const present = (row: Row) => gymSettingsSchema.parse({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
/** The gym's settings, read inside a caller's gym scope so other reads share its transaction and connection (at READ COMMITTED, not one snapshot). */
export async function readGymSettings(tx: Transaction, gymId: string) {
  const [row] = await tx.select(projection).from(gyms).where(eq(gyms.id, gymId));
  if (!row) throw new AppError('not_found', 'Gym not found');
  return present(row);
}
/**
 * Waits while a settings save holds the gym row (a Stripe key change, for one), then keeps the gym's settings from
 * changing until `tx` ends. A key share lock: other updates of the gym row don't wait for it.
 */
export async function holdGymSettings(tx: Transaction, gymId: string) {
  await tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, gymId)).for('key share');
}
/** Read within the invoice's first-failure transaction without nesting gym scopes. */
export async function readBillingRules(tx: Transaction, gymId: string) {
  const [row] = await tx.select({ retryDays: gyms.retryDays }).from(gyms).where(eq(gyms.id, gymId));
  if (!row) throw new AppError('not_found', 'Gym not found');
  return billingRulesSchema.parse(row);
}
/** Read under a caller's session lock (waitlist promotion) without nesting gym scopes. */
export async function readBookingRules(tx: Transaction, gymId: string) {
  const [row] = await tx.select({ bookingWindowDays: gyms.bookingWindowDays, cancellationCutoffMinutes: gyms.cancellationCutoffMinutes }).from(gyms).where(eq(gyms.id, gymId));
  if (!row) throw new AppError('not_found', 'Gym not found');
  return row;
}
/** Each settings kind saves through its own request schema; the kind also names the audit action. */
const updateSchemas = { general: updateGymSettingsRequestSchema, booking: updateBookingRulesRequestSchema,
  billing: updateBillingRulesRequestSchema, currency: updateGymCurrencyRequestSchema, drop_in: updateDropInSettingsRequestSchema } as const;
export function createSettingsService(options: { scope?: typeof forGym; clock?: Clock } = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return {
    async get(gymId: string) {
      return scope(gymId, tx => readGymSettings(tx, gymId));
    },
    async update(context: MutationContext, kind: keyof typeof updateSchemas,
      input: UpdateGymSettingsRequest | UpdateBookingRulesRequest | UpdateBillingRulesRequest | UpdateGymCurrencyRequest | UpdateDropInSettingsRequest) {
      const { revision, ...changes } = updateSchemas[kind].parse(input);
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
          if (kind === 'drop_in' && 'dropInChargeTypeId' in changes && changes.dropInChargeTypeId) {
            // Row-level security hides other gyms' charge types, so their IDs are not found; the share lock holds off an archive until commit.
            const [chargeType] = await tx.select({ active: chargeTypes.active }).from(chargeTypes)
              .where(eq(chargeTypes.id, changes.dropInChargeTypeId)).for('share');
            if (!chargeType) throw new AppError('not_found', 'Charge type not found');
            if (!chargeType.active) throw new AppError('conflict', 'Choose an active charge type');
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
        if (databaseCode(error) === '23503')
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
      bookingWindowDays: value.bookingWindowDays, cancellationCutoffMinutes: value.cancellationCutoffMinutes,
      openMatCountsAsClass: value.openMatCountsAsClass, revision: value.revision };
  } };
}
export const gymSettingsAccessor = createGymSettingsAccessor();
