// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq } from 'drizzle-orm';
import { forGym, classPacks, classPackTaxRates, revisionGuard, assertRevised, uuidv7, type Transaction } from '@plaingym/db';
import { AppError, createTranslator } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../../core/clock.js';
import type { MutationContext } from '../../../core/interfaces/common.js';
import { gymSettingsAccessor } from '../../settings/settings.js';
import { catalogAudit, catalogMissing, catalogTaxLinks, checkCatalogCurrency, validateTaxes as validateCatalogTaxes, type CatalogOptions } from '../catalog.js';
import messages from '../../../../../../locales/en/billing/packs.json' with { type: 'json' };
const t = createTranslator({ 'billing/packs': messages });

const missing = <T>(row: T | undefined): T => catalogMissing(row, t('billing/packs:notFound'));
const present = ({ gymId: _gymId, createdAt, ...row }: typeof classPacks.$inferSelect, taxRateIds: readonly string[]) =>
  c.classPackSchema.parse({ ...row, createdAt: createdAt.toISOString(), taxRateIds });

/** Catalog changes, tax links and audits commit together. No credits are issued here. */
export function createPackCatalogService(options: CatalogOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock, settings = options.settings ?? gymSettingsAccessor;
  const taxIds = async (tx: Transaction, packId: string) => (await catalogTaxLinks(tx, 'pack', [packId])).map(row => row.taxRateId);
  const validateTaxes = (tx: Transaction, ids: readonly string[], existing?: () => Promise<readonly string[]>) =>
    validateCatalogTaxes(tx, ids, existing, { missing: t('billing/packs:taxNotFound'), inactive: t('billing/packs:taxInactive') });
  async function currency(gymId: string, value: string) {
    checkCatalogCurrency(value, (await settings.get(gymId)).currency, t('billing/packs:currencyMismatch'));
  }
  return {
    async list(gymId: string, input: unknown) {
      const query = c.billingCatalogListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        const where = and(query.active === undefined ? undefined : eq(classPacks.active, query.active),
          query.currency === undefined ? undefined : eq(classPacks.currency, query.currency));
        const total = await tx.$count(classPacks, where);
        const rows = await tx.select().from(classPacks).where(where).orderBy(asc(classPacks.name), asc(classPacks.id))
          .limit(query.limit).offset(query.offset);
        const links = await catalogTaxLinks(tx, 'pack', rows.map(row => row.id));
        return { data: rows.map(row => present(row, links.filter(link => link.itemId === row.id).map(link => link.taxRateId))),
          pagination: { limit: query.limit, offset: query.offset, total } };
      });
    },
    async get(gymId: string, id: string) {
      return scope(gymId, async tx => present(missing((await tx.select().from(classPacks).where(eq(classPacks.id, id)))[0]), await taxIds(tx, id)));
    },
    async create(context: MutationContext, input: c.CreateClassPackRequest) {
      const { taxRateIds, ...data } = c.createClassPackRequestSchema.parse(input);
      await currency(context.gymId, data.currency);
      return scope(context.gymId, async tx => {
        await validateTaxes(tx, taxRateIds);
        const row = missing((await tx.insert(classPacks).values({ ...data, id: uuidv7(), gymId: context.gymId, createdAt: clock.now() }).returning())[0]);
        if (taxRateIds.length) await tx.insert(classPackTaxRates).values(taxRateIds.map(taxRateId =>
          ({ id: uuidv7(), gymId: context.gymId, packId: row.id, taxRateId, createdAt: clock.now() })));
        const result = present(row, [...taxRateIds].sort());
        await catalogAudit(tx, context, clock, 'billing.class_pack.created', 'class_pack', row.id, undefined, result);
        return result;
      });
    },
    async update(context: MutationContext, id: string, input: c.UpdateClassPackRequest) {
      const { revision, taxRateIds, ...changes } = c.updateClassPackRequestSchema.parse(input);
      if (changes.currency !== undefined) await currency(context.gymId, changes.currency);
      return scope(context.gymId, async tx => {
        const before = missing((await tx.select().from(classPacks).where(eq(classPacks.id, id)).for('update'))[0]);
        // Re-parse with the stored currency to enforce its charge step on amount-only edits too.
        const price = c.updateClassPackRequestSchema.safeParse({ ...changes, revision, currency: changes.currency ?? before.currency });
        if (!price.success) throw new AppError('invalid_request', price.error.issues[0]!.message);
        const beforeTaxes = taxRateIds === undefined ? await taxIds(tx, id) : await validateTaxes(tx, taxRateIds, () => taxIds(tx, id));
        const guard = revisionGuard(classPacks.revision, revision);
        const row = assertRevised(await tx.update(classPacks).set({ ...changes, revision: guard.next })
          .where(and(eq(classPacks.id, id), guard.matches)).returning());
        if (taxRateIds !== undefined) {
          await tx.delete(classPackTaxRates).where(eq(classPackTaxRates.packId, id));
          if (taxRateIds.length) await tx.insert(classPackTaxRates).values(taxRateIds.map(taxRateId =>
            ({ id: uuidv7(), gymId: context.gymId, packId: id, taxRateId, createdAt: clock.now() })));
        }
        const result = present(row, taxRateIds === undefined ? beforeTaxes : await taxIds(tx, id));
        await catalogAudit(tx, context, clock, 'billing.class_pack.updated', 'class_pack', id, present(before, beforeTaxes), result);
        return result;
      });
    },
  };
}
export type PackCatalogService = ReturnType<typeof createPackCatalogService>;
