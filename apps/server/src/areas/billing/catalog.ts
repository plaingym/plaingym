// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, eq, inArray, ne } from 'drizzle-orm';
import { forGym, plans, taxRates, chargeTypes, planTaxRates, chargeTypeTaxRates, classPacks, classPackTaxRates, memberships,
  revisionGuard, assertRevised, RevisionConflictError, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, createTranslator, type Clock } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { z } from 'zod';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { clock as defaultClock } from '../../core/clock.js';
import { gymSettingsAccessor } from '../settings/settings.js';
import messages from '../../../../../locales/en/billing/catalog.json' with { type: 'json' };
const text = createTranslator({ 'billing/catalog': messages });

/**
 * An update's new amounts, and every amount when it changes the currency, must sit on the step of the currency they
 * will be charged in (the request schemas check a request that names its currency). Otherwise unchanged amounts, even
 * ones stored off the step, are left alone.
 */
type Prices = { currency: string; amountCents: number; signupFeeCents?: number | undefined };
const priceStepSchema = z.object({ currency: c.currencySchema, amountCents: z.number().optional(), signupFeeCents: z.number().optional() })
  .superRefine(c.refinePriceStep(['amountCents', 'signupFeeCents']));
function checkPriceStep(before: Prices, changes: { [K in keyof Prices]?: Prices[K] | undefined }) {
  const currency = changes.currency ?? before.currency, changedCurrency = currency !== before.currency;
  const result = priceStepSchema.safeParse({ currency,
    amountCents: changes.amountCents ?? (changedCurrency ? before.amountCents : undefined),
    signupFeeCents: changes.signupFeeCents ?? (changedCurrency ? before.signupFeeCents : undefined) });
  if (!result.success) throw new AppError('invalid_request', result.error.issues[0]!.message);
}

export function catalogMissing<T>(row: T | undefined, message = 'Resource not found'): T {
  if (!row) throw new AppError('not_found', message);
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
export function checkCatalogCurrency(value: string, gymCurrency: string, message = 'Currency does not match the gym') {
  if (value !== gymCurrency) throw new AppError('conflict', message);
}
/** Lock rates before reading links, so a confirmed detach cannot be reattached by a waiting edit. */
export async function validateTaxes(tx: Transaction, ids: readonly string[], existing: () => Promise<readonly string[]> = async () => [],
  errors = { missing: 'Tax rate not found', inactive: 'Tax rate is inactive' }) {
  const rows = ids.length ? await tx.select({ id: taxRates.id, active: taxRates.active }).from(taxRates)
    .where(inArray(taxRates.id, [...ids])).orderBy(asc(taxRates.id)).for('share') : [];
  if (rows.length !== ids.length) throw new AppError('not_found', errors.missing);
  const linked = await existing();
  if (rows.some(row => !row.active && !linked.includes(row.id))) throw new AppError('conflict', errors.inactive);
  return linked;
}
/** A common projection for catalog pages and single-item reads. */
export async function catalogTaxLinks(tx: Transaction, kind: 'plan' | 'charge_type' | 'pack', ids: readonly string[]) {
  if (!ids.length) return [];
  const table = kind === 'plan' ? planTaxRates : kind === 'charge_type' ? chargeTypeTaxRates : classPackTaxRates;
  const itemId = kind === 'plan' ? planTaxRates.planId : kind === 'charge_type' ? chargeTypeTaxRates.chargeTypeId : classPackTaxRates.packId;
  return tx.select({ itemId, taxRateId: table.taxRateId }).from(table)
    .where(inArray(itemId, [...ids])).orderBy(asc(table.taxRateId));
}
/** Links and catalog edits commit with their audit, under the catalog row lock. */
export function createCatalogService(options: CatalogOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const settings = options.settings ?? gymSettingsAccessor;
  async function currency(gymId: string, value: string) {
    checkCatalogCurrency(value, (await settings.get(gymId)).currency);
  }
  const planTaxIds = async (tx: Transaction, id: string) => (await catalogTaxLinks(tx, 'plan', [id])).map(link => link.taxRateId);
  const chargeTaxIds = async (tx: Transaction, id: string) => (await catalogTaxLinks(tx, 'charge_type', [id])).map(link => link.taxRateId);
  /** Every charge type, class pack and plan carrying the rate, and the memberships (not cancelled) on those plans. */
  async function taxUsage(tx: Transaction, id: string): Promise<c.TaxRateUsage> {
    const packs = await tx.select({ id: classPacks.id, name: classPacks.name, active: classPacks.active }).from(classPackTaxRates)
      .innerJoin(classPacks, eq(classPacks.id, classPackTaxRates.packId)).where(eq(classPackTaxRates.taxRateId, id))
      .orderBy(asc(classPacks.name), asc(classPacks.id));
    const charges = await tx.select({ id: chargeTypes.id, name: chargeTypes.name, active: chargeTypes.active }).from(chargeTypeTaxRates)
      .innerJoin(chargeTypes, eq(chargeTypes.id, chargeTypeTaxRates.chargeTypeId)).where(eq(chargeTypeTaxRates.taxRateId, id))
      .orderBy(asc(chargeTypes.name), asc(chargeTypes.id));
    const attached = await tx.select({ id: plans.id, name: plans.name, active: plans.active }).from(planTaxRates)
      .innerJoin(plans, eq(plans.id, planTaxRates.planId)).where(eq(planTaxRates.taxRateId, id)).orderBy(asc(plans.name), asc(plans.id));
    const counts = attached.length ? await tx.select({ planId: memberships.planId, total: count() }).from(memberships)
      .where(and(inArray(memberships.planId, attached.map(plan => plan.id)), ne(memberships.status, 'cancelled'))).groupBy(memberships.planId) : [];
    const planned = attached.map(plan => ({ ...plan, memberships: counts.find(row => row.planId === plan.id)?.total ?? 0 }));
    return c.taxRateUsageSchema.parse({ chargeTypes: charges, packs, plans: planned,
      memberships: planned.reduce((sum, plan) => sum + plan.memberships, 0) });
  }
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
    async getTaxRateUsage(gymId: string, id: string) {
      return scope(gymId, async tx => {
        catalogMissing((await tx.select({ id: taxRates.id }).from(taxRates).where(eq(taxRates.id, id)))[0]);
        return taxUsage(tx, id);
      });
    },
    /**
     * Archiving an active rate that charge types, class packs or plans still carry is a conflict listing them, unless
     * `detach` confirms it: then every link goes and the rate is archived in this transaction, with one audit
     * naming each item. A plan, class pack or charge type edit takes a share lock on the rate before reading its links
     * (validateTaxes), so it can't attach the rate again once this commits.
     */
    async updateTaxRate(context: MutationContext, id: string, input: c.UpdateTaxRateRequest) {
      const { revision, detach, ...changes } = c.updateTaxRateRequestSchema.parse(input);
      return scope(context.gymId, async tx => {
        const before = catalogMissing((await tx.select().from(taxRates).where(eq(taxRates.id, id)).for('update'))[0]);
        const guard = revisionGuard(taxRates.revision, revision);
        // Only an archive of an active rate, or a confirmed detach, needs to know what carries the rate.
        const usage = changes.active === false && (before.active || detach) ? await taxUsage(tx, id) : undefined;
        const attached = usage && (usage.chargeTypes.length || usage.plans.length || usage.packs.length) ? usage : undefined;
        // A rate archived and attached before this rule stays editable as it is; `detach` still clears it.
        if (attached && before.active && !detach) {
          // A stale revision stays a plain revision conflict, so the client reloads before deciding.
          if (before.revision !== revision) throw new RevisionConflictError();
          throw new AppError('conflict', text('billing/catalog:taxAttached', { charges: attached.chargeTypes.length,
            packs: attached.packs.length, plans: attached.plans.length, memberships: attached.memberships }),
          { reason: ['tax_rate_attached'], chargeTypes: attached.chargeTypes.map(item => item.name),
            plans: attached.plans.map(item => item.name), packs: attached.packs.map(item => item.name), memberships: [String(attached.memberships)] });
        }
        const result = presentTax(assertRevised(await tx.update(taxRates).set({ ...changes, revision: guard.next }).where(and(eq(taxRates.id, id), guard.matches)).returning()));
        if (!attached || !detach) {
          await catalogAudit(tx, context, clock, 'billing.tax_rate.updated', 'tax_rate', id, presentTax(before), result);
          return result;
        }
        await tx.delete(chargeTypeTaxRates).where(eq(chargeTypeTaxRates.taxRateId, id));
        await tx.delete(planTaxRates).where(eq(planTaxRates.taxRateId, id));
        await tx.delete(classPackTaxRates).where(eq(classPackTaxRates.taxRateId, id));
        await catalogAudit(tx, context, clock, before.active ? 'billing.tax_rate.archived' : 'billing.tax_rate.detached', 'tax_rate', id,
          { ...presentTax(before), attachedTo: attached }, { ...result, detachedFrom: attached });
        return result;
      });
    },
    async listPlans(gymId: string, input: unknown) {
      const query = c.billingCatalogListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        const where = and(query.active === undefined ? undefined : eq(plans.active, query.active), query.currency === undefined ? undefined : eq(plans.currency, query.currency));
        const total = await tx.$count(plans, where);
        const rows = await tx.select().from(plans).where(where).orderBy(asc(plans.name), asc(plans.id)).limit(query.limit).offset(query.offset);
        const attached = await catalogTaxLinks(tx, 'plan', rows.map(row => row.id));
        return { data: rows.map(row => presentPlan(row, attached.filter(link => link.itemId === row.id).map(link => link.taxRateId))),
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
        checkPriceStep(before, changes);
        const beforeTaxes = taxRateIds !== undefined ? await validateTaxes(tx, taxRateIds, () => planTaxIds(tx, id)) : await planTaxIds(tx, id);
        const guard = revisionGuard(plans.revision, revision);
        const row = assertRevised(await tx.update(plans).set({ ...changes, revision: guard.next }).where(and(eq(plans.id, id), guard.matches)).returning());
        if (taxRateIds !== undefined) {
          await tx.delete(planTaxRates).where(eq(planTaxRates.planId, id));
          if (taxRateIds.length) await tx.insert(planTaxRates).values(taxRateIds.map(taxRateId => ({ gymId: context.gymId, id: uuidv7(), planId: id, taxRateId, createdAt: clock.now() })));
        }
        const result = presentPlan(row, taxRateIds === undefined ? beforeTaxes : await planTaxIds(tx, id));
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
        const attached = await catalogTaxLinks(tx, 'charge_type', rows.map(row => row.id));
        return { data: rows.map(row => presentCharge(row, attached.filter(link => link.itemId === row.id).map(link => link.taxRateId))),
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
        checkPriceStep(before, changes);
        const beforeTaxes = taxRateIds !== undefined ? await validateTaxes(tx, taxRateIds, () => chargeTaxIds(tx, id)) : await chargeTaxIds(tx, id);
        const guard = revisionGuard(chargeTypes.revision, revision);
        const row = assertRevised(await tx.update(chargeTypes).set({ ...changes, revision: guard.next }).where(and(eq(chargeTypes.id, id), guard.matches)).returning());
        if (taxRateIds !== undefined) {
          await tx.delete(chargeTypeTaxRates).where(eq(chargeTypeTaxRates.chargeTypeId, id));
          if (taxRateIds.length) await tx.insert(chargeTypeTaxRates).values(taxRateIds.map(taxRateId => ({ gymId: context.gymId, id: uuidv7(), chargeTypeId: id, taxRateId, createdAt: clock.now() })));
        }
        const result = presentCharge(row, taxRateIds === undefined ? beforeTaxes : await chargeTaxIds(tx, id));
        await catalogAudit(tx, context, clock, 'billing.charge_type.updated', 'charge_type', id, presentCharge(before, beforeTaxes), result);
        return result;
      });
    },
  };
  return service;
}
export type CatalogService = ReturnType<typeof createCatalogService>;
