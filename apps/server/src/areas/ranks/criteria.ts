// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import { AppError, Registry } from '@plaingym/shared';
import { localDate } from '@plaingym/shared/time';
import type { PromotionCriterion, CriterionProgress } from '@plaingym/shared/contracts';
import type { AttendanceQueries } from '../../core/interfaces/attendance.js';
import type { CriterionContext, PromotionCriterionProvider } from '../../core/interfaces/extensions.js';
import type { forGym } from '@plaingym/db';
import { countPromotionAttendance, promotionAttendanceKey } from '../attendance/promotion.query.js';

const targetSchema = z.strictObject({ target: z.int32().nonnegative() });
const progress = (current: number, target: number) => ({ current, target, met: current >= target });
interface BatchReads { scope: typeof forGym; gymId: string; until: string; openMatCountsAsClass: boolean; }
/** Optional optimization local to ranks; the public provider interface stays unchanged. */
export interface BatchCriterionProvider extends PromotionCriterionProvider {
  prepareBatch?(contexts: readonly CriterionContext[], reads: BatchReads): Promise<PromotionCriterionProvider['evaluate']>;
}
const attendanceRequest = (context: CriterionContext) => ({ memberId: context.memberId, programId: context.programId,
  since: context.promotedAt ?? '1970-01-01T00:00:00.000Z' });

/** Providers are injected by modules; unavailable providers fail closed. */
export class PromotionCriteria extends Registry<BatchCriterionProvider> {
  override register(provider: BatchCriterionProvider): void {
    // Registry stores a frozen copy; retain prototype methods and private state.
    super.register({ id: provider.id, labelKey: provider.labelKey, configSchema: provider.configSchema,
      ...(provider.order === undefined ? {} : { order: provider.order }),
      ...(provider.moduleId === undefined ? {} : { moduleId: provider.moduleId }),
      evaluate: provider.evaluate.bind(provider),
      ...(provider.prepareBatch ? { prepareBatch: provider.prepareBatch.bind(provider) } : {}) });
  }
  async prepareBatch(candidates: readonly { context: CriterionContext; rank: { criteria: readonly PromotionCriterion[] } }[],
    enabled: ReadonlySet<string>, reads: BatchReads): Promise<PromotionCriteria> {
    // A batch read counts in the gym scope up to reads.until; refuse any context that would be counted differently.
    const until = Date.parse(reads.until);
    for (const { context } of candidates) {
      if (context.attendanceScope.kind !== 'gym' || context.attendanceScope.gymId !== reads.gymId || context.gymId !== reads.gymId
        || context.clock.now().getTime() !== until)
        throw new AppError('conflict', 'Promotion batch reads require matching gym scope and clock');
    }
    // Fail closed before any provider starts its batch reads, including disabled module criteria.
    for (const candidate of candidates) this.validate(candidate.rank.criteria, enabled);
    const batch = new PromotionCriteria();
    for (const provider of this.forModules(enabled)) {
      const contexts = candidates.filter(candidate => candidate.rank.criteria.some(item => item.providerId === provider.id)).map(candidate => candidate.context);
      batch.register({ ...provider, evaluate: contexts.length && provider.prepareBatch
        ? await provider.prepareBatch(contexts, reads) : provider.evaluate });
    }
    return batch;
  }
  validate(criteria: readonly PromotionCriterion[], enabled?: ReadonlySet<string>): void {
    const providers = enabled ? this.forModules(enabled) : this.all();
    for (const criterion of criteria) {
      const provider = providers.find((item) => item.id === criterion.providerId);
      if (!provider || !provider.configSchema.safeParse(criterion.config).success)
        throw new AppError('conflict', 'Promotion criterion is unavailable or has invalid configuration');
    }
  }
  async evaluate(context: CriterionContext, criteria: readonly PromotionCriterion[], enabled: ReadonlySet<string>): Promise<CriterionProgress[]> {
    this.validate(criteria, enabled);
    return Promise.all(criteria.map(async (criterion) => {
      const provider = this.forModules(enabled).find((item) => item.id === criterion.providerId)!;
      const result = await provider.evaluate(context, provider.configSchema.parse(criterion.config));
      if (!Number.isFinite(result.current) || result.current < 0 || !Number.isFinite(result.target)
        || result.target < 0 || result.met !== (result.current >= result.target))
        throw new AppError('conflict', 'Promotion criterion returned invalid progress');
      return { providerId: provider.id, labelKey: provider.labelKey, ...result };
    }));
  }
}

export function createPromotionCriteria(attendance: AttendanceQueries): PromotionCriteria {
  const registry = new PromotionCriteria();
  registry.register({ id: 'classes-since-promotion', labelKey: 'ranks/ranks:classes', configSchema: targetSchema,
    async prepareBatch(contexts, reads) {
      const counts = await countPromotionAttendance(reads.scope, reads.gymId, contexts.map(attendanceRequest), reads.until, reads.openMatCountsAsClass);
      return async (context, value) => progress(counts.get(promotionAttendanceKey(attendanceRequest(context))) ?? 0, targetSchema.parse(value).target);
    },
    async evaluate(context, value) {
      const { target } = targetSchema.parse(value);
      const current = await attendance.countSince(context.attendanceScope, {
        ...attendanceRequest(context), classesOnly: true, until: context.clock.now().toISOString(),
      });
      return progress(current, target);
    },
  });
  registry.register({ id: 'time-at-rank', labelKey: 'ranks/ranks:days', configSchema: targetSchema,
    async evaluate(context, value) {
      const { target } = targetSchema.parse(value);
      const current = context.promotedAt === null ? 0
        : Math.max(0, Math.floor((context.clock.now().getTime() - Date.parse(context.promotedAt)) / 86_400_000));
      return progress(current, target);
    },
  });
  registry.register({ id: 'minimum-age', labelKey: 'ranks/ranks:age', configSchema: targetSchema,
    async evaluate(context, value) {
      const { target } = targetSchema.parse(value);
      if (context.dateOfBirth === null) return { current: 0, target, met: target === 0 };
      const today = localDate(context.clock.now(), context.timezone);
      const current = Math.max(0, Number(today.slice(0, 4)) - Number(context.dateOfBirth.slice(0, 4))
        - (today.slice(5) < context.dateOfBirth.slice(5) ? 1 : 0));
      return progress(current, target);
    },
  });
  return registry;
}
