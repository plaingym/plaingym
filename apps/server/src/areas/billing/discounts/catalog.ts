// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray } from 'drizzle-orm';
import { forGym, discounts, discountPlans, membershipDiscounts, plans, databaseCode, revisionGuard, assertRevised,
  RevisionConflictError, uuidv7, type Transaction } from '@plaingym/db';
import { AppError, createTranslator } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../../core/clock.js';
import type { MutationContext } from '../../../core/interfaces/common.js';
import { gymSettingsAccessor } from '../../settings/settings.js';
import { catalogAudit, type CatalogOptions } from '../catalog.js';
import messages from '../../../../../../locales/en/billing/discounts.json' with { type: 'json' };

const t = createTranslator({ 'billing/discounts': messages });
function missing<T>(row: T | undefined): T {
  if (!row) throw new AppError('not_found', t('billing/discounts:notFound'));
  return row;
}
const present = ({ gymId: _gymId, createdAt, ...row }: typeof discounts.$inferSelect, planIds: readonly string[], termsLocked: boolean) =>
  c.discountSchema.parse({ ...row, createdAt: createdAt.toISOString(), planIds, termsLocked });
const editable = ({ id: _id, createdAt: _createdAt, uses: _uses, termsLocked: _termsLocked, revision: _revision, ...fields }: c.Discount) => fields;
// Responses and audits show plan IDs as the database returns them, whatever case the request used.
const lower = (ids: readonly string[]) => [...new Set(ids.map(id => id.toLowerCase()))];
const termKeys = ['percentBasisPoints', 'amountCents', 'currency', 'waivesSignupFee', 'duration', 'cycles'] as const;
async function unique<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (databaseCode(error) === '23505') throw new AppError('conflict', t('billing/discounts:duplicate'));
    throw error;
  }
}

/** Catalog, plan links and audit commit together. This service never applies a discount or increments uses. */
export function createDiscountCatalogService(options: CatalogOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock, settings = options.settings ?? gymSettingsAccessor;
  const planIds = async (tx: Transaction, id: string) => (await tx.select({ id: discountPlans.planId }).from(discountPlans)
    .where(eq(discountPlans.discountId, id)).orderBy(asc(discountPlans.planId))).map(row => row.id);
  const termsLocked = async (tx: Transaction, id: string) => (await tx.select({ id: membershipDiscounts.id }).from(membershipDiscounts)
    .where(eq(membershipDiscounts.discountId, id)).limit(1)).length > 0;
  async function validatePlans(tx: Transaction, ids: readonly string[]) {
    const found = ids.length ? await tx.select({ id: plans.id }).from(plans).where(inArray(plans.id, [...ids]))
      .orderBy(asc(plans.id)).for('share') : [];
    if (found.length !== ids.length) throw new AppError('not_found', t('billing/discounts:planNotFound'));
  }
  async function replacePlans(tx: Transaction, gymId: string, discountId: string, ids: readonly string[]) {
    await tx.delete(discountPlans).where(eq(discountPlans.discountId, discountId));
    if (ids.length) await tx.insert(discountPlans).values(ids.map(planId =>
      ({ id: uuidv7(), gymId, discountId, planId, createdAt: clock.now() })));
  }
  async function currency(gymId: string, value: string) {
    if ((await settings.get(gymId)).currency !== value) throw new AppError('conflict', t('billing/discounts:currencyMismatch'));
  }
  return {
    async list(gymId: string, input: unknown) {
      const query = c.discountListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        const where = query.active === undefined ? undefined : eq(discounts.active, query.active);
        const total = await tx.$count(discounts, where);
        const rows = await tx.select().from(discounts).where(where).orderBy(asc(discounts.name), asc(discounts.id))
          .limit(query.limit).offset(query.offset);
        const links = rows.length ? await tx.select().from(discountPlans).where(inArray(discountPlans.discountId, rows.map(row => row.id)))
          .orderBy(asc(discountPlans.planId)) : [];
        const history = rows.length ? await tx.selectDistinct({ id: membershipDiscounts.discountId }).from(membershipDiscounts)
          .where(inArray(membershipDiscounts.discountId, rows.map(row => row.id))) : [];
        const lockedIds = new Set(history.map(row => row.id));
        return { data: rows.map(row => present(row, links.filter(link => link.discountId === row.id).map(link => link.planId), lockedIds.has(row.id))),
          pagination: { limit: query.limit, offset: query.offset, total } };
      });
    },
    async get(gymId: string, id: string) {
      return scope(gymId, async tx => present(missing((await tx.select().from(discounts).where(eq(discounts.id, id)))[0]),
        await planIds(tx, id), await termsLocked(tx, id)));
    },
    async create(context: MutationContext, input: c.CreateDiscountRequest) {
      const { planIds: requested, ...data } = c.createDiscountRequestSchema.parse(input), ids = lower(requested);
      await currency(context.gymId, data.currency);
      return unique(() => scope(context.gymId, async tx => {
        await validatePlans(tx, ids);
        const row = missing((await tx.insert(discounts).values({ ...data, id: uuidv7(), gymId: context.gymId, createdAt: clock.now() }).returning())[0]);
        await replacePlans(tx, context.gymId, row.id, ids);
        const result = present(row, [...ids].sort(), false);
        await catalogAudit(tx, context, clock, 'billing.discount.created', 'discount', row.id, undefined, result);
        return result;
      }));
    },
    async update(context: MutationContext, id: string, input: c.UpdateDiscountRequest) {
      const { revision, planIds: requested, ...changes } = c.updateDiscountRequestSchema.parse(input);
      const ids = requested === undefined ? undefined : lower(requested);
      return unique(() => scope(context.gymId, async tx => {
        // Applications must take this same lock before reading terms and creating their snapshot.
        const before = missing((await tx.select().from(discounts).where(eq(discounts.id, id)).for('update'))[0]);
        if (before.revision !== revision) throw new RevisionConflictError();
        const beforePlans = await planIds(tx, id);
        const locked = await termsLocked(tx, id);
        const old = present(before, beforePlans, locked);
        const checked = c.createDiscountRequestSchema.safeParse({ ...editable(old), ...changes, planIds: ids ?? beforePlans });
        if (!checked.success) throw new AppError('invalid_request', checked.error.issues[0]!.message);
        const merged = checked.data;
        if (merged.currency !== before.currency) throw new AppError('conflict', t('billing/discounts:currencyMismatch'));
        if (merged.maxUses !== null && merged.maxUses < before.uses) throw new AppError('conflict', t('billing/discounts:maxUses'));
        if (locked && termKeys.some(key => merged[key] !== before[key])) throw new AppError('conflict', t('billing/discounts:termsUsed'));
        if (ids !== undefined) await validatePlans(tx, ids);
        const guard = revisionGuard(discounts.revision, revision);
        const row = assertRevised(await tx.update(discounts).set({ ...changes, revision: guard.next })
          .where(and(eq(discounts.id, id), guard.matches)).returning());
        if (ids !== undefined) await replacePlans(tx, context.gymId, id, ids);
        const result = present(row, [...(ids ?? beforePlans)].sort(), locked);
        await catalogAudit(tx, context, clock, 'billing.discount.updated', 'discount', id, old, result);
        return result;
      }));
    },
  };
}
export type DiscountCatalogService = ReturnType<typeof createDiscountCatalogService>;
