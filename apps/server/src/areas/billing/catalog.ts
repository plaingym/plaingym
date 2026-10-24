// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray } from 'drizzle-orm';
import { forGym, plans, taxRates, chargeTypes, planTaxRates, chargeTypeTaxRates,
  revisionGuard, assertRevised, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { clock as defaultClock } from '../../core/clock.js';
import { gymSettingsAccessor } from '../settings/settings.js';

export function catalogMissing<T>(row: T | undefined): T {
  if (!row) throw new AppError('not_found', 'Resource not found');
  return row;
}
export function catalogAudit(tx: Transaction, context: MutationContext, clock: Clock,
  action: string, targetType: string, targetId: string, before?: unknown, after?: unknown) {
  return writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
    ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
    action, targetType, targetId, occurredAt: clock.now(), before, after });
}
type Stored = { gymId: string; createdAt: Date };
const fields = <T extends Stored>({ gymId: _gymId, ...row }: T) => ({ ...row, createdAt: row.createdAt.toISOString() });
const presentTax = (row: typeof taxRates.$inferSelect) => c.taxRateSchema.parse(fields(row));
const presentPlan = (row: typeof plans.$inferSelect, taxRateIds: readonly string[]) => c.planSchema.parse({ ...fields(row), taxRateIds });
const presentCharge = (row: typeof chargeTypes.$inferSelect, taxRateIds: readonly string[]) => c.chargeTypeSchema.parse({ ...fields(row), taxRateIds });
export interface CatalogOptions { scope?: typeof forGym; clock?: Clock; settings?: GymSettingsAccessor }
/** Links and catalog edits commit with their audit, under the catalog row lock. */
export function createCatalogService(options: CatalogOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const settings = options.settings ?? gymSettingsAccessor;
  async function currency(gymId: string, value: string) {
    if ((await settings.get(gymId)).currency !== value) throw new AppError('conflict', 'Currency does not match the gym');
  }
  async function validateTaxes(tx: Transaction, ids: readonly string[], existing: readonly string[] = []) {
    if (!ids.length) return;
    const rows = await tx.select({ id: taxRates.id, active: taxRates.active }).from(taxRates)
      .where(inArray(taxRates.id, [...ids])).orderBy(asc(taxRates.id)).for('share');
    if (rows.length !== ids.length) throw new AppError('not_found', 'Tax rate not found');
    if (rows.some(row => !row.active && !existing.includes(row.id))) throw new AppError('conflict', 'Tax rate is inactive');
  }
  const planTaxIds = async (tx: Transaction, id: string) => (await tx.select({ id: planTaxRates.taxRateId }).from(planTaxRates)
    .where(eq(planTaxRates.planId, id)).orderBy(asc(planTaxRates.taxRateId))).map(link => link.id);
  const chargeTaxIds = async (tx: Transaction, id: string) => (await tx.select({ id: chargeTypeTaxRates.taxRateId }).from(chargeTypeTaxRates)
    .where(eq(chargeTypeTaxRates.chargeTypeId, id)).orderBy(asc(chargeTypeTaxRates.taxRateId))).map(link => link.id);
  const service = {
    async listTaxRates(gymId: string, input: unknown) {
      const query = c.billingTaxRateListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        const where = and(query.active === undefined ? undefined : eq(taxRates.active, query.active));
        const total = await tx.$count(taxRates, where);
        const rows = await tx.select().from(taxRates).where(where).orderBy(asc(taxRates.name), asc(taxRates.id)).limit(query.limit).offset(query.offset);
        return { data: rows.map(presentTax),
          pagination: { limit: query.limit, offset: query.offset, total } };
      });
    },
    async getTaxRate(gymId: string, id: string) {
      return scope(gymId, async tx => presentTax(catalogMissing((await tx.select().from(taxRates).where(eq(taxRates.id, id)))[0])));
    },
    async createTaxRate(context: MutationContext, input: c.CreateTaxRateRequest) {
      const data = c.createTaxRateRequestSchema.parse(input);
      return scope(context.gymId, async tx => {
        const result = presentTax(catalogMissing((await tx.insert(taxRates).values({ ...data, gymId: context.gymId, id: uuidv7(), createdAt: clock.now() }).returning())[0]));
        await catalogAudit(tx, context, clock, 'billing.tax_rate.created', 'tax_rate', result.id, undefined, result);
        return result;
      });
    },
    async updateTaxRate(context: MutationContext, id: string, input: c.UpdateTaxRateRequest) {
      const { revision, ...changes } = c.updateTaxRateRequestSchema.parse(input);
      return scope(context.gymId, async tx => {
        const before = catalogMissing((await tx.select().from(taxRates).where(eq(taxRates.id, id)).for('update'))[0]);
        const guard = revisionGuard(taxRates.revision, revision);
        const result = presentTax(assertRevised(await tx.update(taxRates).set({ ...changes, revision: guard.next }).where(and(eq(taxRates.id, id), guard.matches)).returning()));
        await catalogAudit(tx, context, clock, 'billing.tax_rate.updated', 'tax_rate', id, presentTax(before), result);
        return result;
      });
    },
    async listPlans(gymId: string, input: unknown) {
      const query = c.billingCatalogListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        const where = and(query.active === undefined ? undefined : eq(plans.active, query.active), query.currency === undefined ? undefined : eq(plans.currency, query.currency));
        const total = await tx.$count(plans, where);
        const rows = await tx.select().from(plans).where(where).orderBy(asc(plans.name), asc(plans.id)).limit(query.limit).offset(query.offset);
        const attached = rows.length ? await tx.select().from(planTaxRates).where(inArray(planTaxRates.planId, rows.map(row => row.id))).orderBy(asc(planTaxRates.taxRateId)) : [];
        return { data: rows.map(row => presentPlan(row, attached.filter(link => link.planId === row.id).map(link => link.taxRateId))),
          pagination: { limit: query.limit, offset: query.offset, total } };
      });
    },
    async getPlan(gymId: string, id: string) {
      return scope(gymId, async tx => presentPlan(catalogMissing((await tx.select().from(plans).where(eq(plans.id, id)))[0]), await planTaxIds(tx, id)));
    },
    async createPlan(context: MutationContext, input: c.CreatePlanRequest) {
      const { taxRateIds, ...data } = c.createPlanRequestSchema.parse(input);
      await currency(context.gymId, data.currency);
      return scope(context.gymId, async tx => {
        await validateTaxes(tx, taxRateIds);
        const row = catalogMissing((await tx.insert(plans).values({ ...data, gymId: context.gymId, id: uuidv7(), createdAt: clock.now() }).returning())[0]);
        if (taxRateIds.length) await tx.insert(planTaxRates).values(taxRateIds.map(taxRateId => ({ gymId: context.gymId, id: uuidv7(), planId: row.id, taxRateId, createdAt: clock.now() })));
        const result = presentPlan(row, [...taxRateIds].sort());
        await catalogAudit(tx, context, clock, 'billing.plan.created', 'plan', row.id, undefined, result);
        return result;
      });
    },
    async updatePlan(context: MutationContext, id: string, input: c.UpdatePlanRequest) {
      const { revision, taxRateIds, ...changes } = c.updatePlanRequestSchema.parse(input);
      if (changes.currency !== undefined) await currency(context.gymId, changes.currency);
      return scope(context.gymId, async tx => {
        const before = catalogMissing((await tx.select().from(plans).where(eq(plans.id, id)).for('update'))[0]);
        const beforeTaxes = await planTaxIds(tx, id);
        if (taxRateIds !== undefined) await validateTaxes(tx, taxRateIds, beforeTaxes);
        const guard = revisionGuard(plans.revision, revision);
        const row = assertRevised(await tx.update(plans).set({ ...changes, revision: guard.next }).where(and(eq(plans.id, id), guard.matches)).returning());
        if (taxRateIds !== undefined) {
          await tx.delete(planTaxRates).where(eq(planTaxRates.planId, id));
          if (taxRateIds.length) await tx.insert(planTaxRates).values(taxRateIds.map(taxRateId => ({ gymId: context.gymId, id: uuidv7(), planId: id, taxRateId, createdAt: clock.now() })));
        }
        const result = presentPlan(row, await planTaxIds(tx, id));
        await catalogAudit(tx, context, clock, 'billing.plan.updated', 'plan', id, presentPlan(before, beforeTaxes), result);
        return result;
      });
    },
    async listChargeTypes(gymId: string, input: unknown) {
      const query = c.billingCatalogListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        const where = and(query.active === undefined ? undefined : eq(chargeTypes.active, query.active), query.currency === undefined ? undefined : eq(chargeTypes.currency, query.currency));
        const total = await tx.$count(chargeTypes, where);
        const rows = await tx.select().from(chargeTypes).where(where).orderBy(asc(chargeTypes.name), asc(chargeTypes.id)).limit(query.limit).offset(query.offset);
        const attached = rows.length ? await tx.select().from(chargeTypeTaxRates).where(inArray(chargeTypeTaxRates.chargeTypeId, rows.map(row => row.id))).orderBy(asc(chargeTypeTaxRates.taxRateId)) : [];
        return { data: rows.map(row => presentCharge(row, attached.filter(link => link.chargeTypeId === row.id).map(link => link.taxRateId))),
          pagination: { limit: query.limit, offset: query.offset, total } };
      });
    },
    async getChargeType(gymId: string, id: string) {
      return scope(gymId, async tx => presentCharge(catalogMissing((await tx.select().from(chargeTypes).where(eq(chargeTypes.id, id)))[0]), await chargeTaxIds(tx, id)));
    },
    async createChargeType(context: MutationContext, input: c.CreateChargeTypeRequest) {
      const { taxRateIds, ...data } = c.createChargeTypeRequestSchema.parse(input);
      await currency(context.gymId, data.currency);
      return scope(context.gymId, async tx => {
        await validateTaxes(tx, taxRateIds);
        const row = catalogMissing((await tx.insert(chargeTypes).values({ ...data, gymId: context.gymId, id: uuidv7(), createdAt: clock.now() }).returning())[0]);
        if (taxRateIds.length) await tx.insert(chargeTypeTaxRates).values(taxRateIds.map(taxRateId => ({ gymId: context.gymId, id: uuidv7(), chargeTypeId: row.id, taxRateId, createdAt: clock.now() })));
        const result = presentCharge(row, [...taxRateIds].sort());
        await catalogAudit(tx, context, clock, 'billing.charge_type.created', 'charge_type', row.id, undefined, result);
        return result;
      });
    },
    async updateChargeType(context: MutationContext, id: string, input: c.UpdateChargeTypeRequest) {
      const { revision, taxRateIds, ...changes } = c.updateChargeTypeRequestSchema.parse(input);
      if (changes.currency !== undefined) await currency(context.gymId, changes.currency);
      return scope(context.gymId, async tx => {
        const before = catalogMissing((await tx.select().from(chargeTypes).where(eq(chargeTypes.id, id)).for('update'))[0]);
        const beforeTaxes = await chargeTaxIds(tx, id);
        if (taxRateIds !== undefined) await validateTaxes(tx, taxRateIds, beforeTaxes);
        const guard = revisionGuard(chargeTypes.revision, revision);
        const row = assertRevised(await tx.update(chargeTypes).set({ ...changes, revision: guard.next }).where(and(eq(chargeTypes.id, id), guard.matches)).returning());
        if (taxRateIds !== undefined) {
          await tx.delete(chargeTypeTaxRates).where(eq(chargeTypeTaxRates.chargeTypeId, id));
          if (taxRateIds.length) await tx.insert(chargeTypeTaxRates).values(taxRateIds.map(taxRateId => ({ gymId: context.gymId, id: uuidv7(), chargeTypeId: id, taxRateId, createdAt: clock.now() })));
        }
        const result = presentCharge(row, await chargeTaxIds(tx, id));
        await catalogAudit(tx, context, clock, 'billing.charge_type.updated', 'charge_type', id, presentCharge(before, beforeTaxes), result);
        return result;
      });
    },
  };
  return service;
}
export type CatalogService = ReturnType<typeof createCatalogService>;
