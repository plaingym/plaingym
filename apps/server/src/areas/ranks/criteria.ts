// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import { AppError, Registry } from '@plaingym/shared';
import type { PromotionCriterion, CriterionProgress } from '@plaingym/shared/contracts';
import type { AttendanceQueries } from '../../core/interfaces/attendance.js';
import type { CriterionContext, PromotionCriterionProvider } from '../../core/interfaces/extensions.js';

const targetSchema = z.strictObject({ target: z.int32().nonnegative() });
const progress = (current: number, target: number) => ({ current, target, met: current >= target });

/** Providers are injected by modules; unavailable providers fail closed. */
export class PromotionCriteria extends Registry<PromotionCriterionProvider> {
  override register(provider: PromotionCriterionProvider): void {
    // Registry stores a frozen copy; retain prototype methods and private state.
    super.register({ id: provider.id, labelKey: provider.labelKey, configSchema: provider.configSchema,
      ...(provider.order === undefined ? {} : { order: provider.order }),
      ...(provider.moduleId === undefined ? {} : { moduleId: provider.moduleId }),
      evaluate: provider.evaluate.bind(provider) });
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
    async evaluate(context, value) {
      const { target } = targetSchema.parse(value);
      const current = await attendance.countSince(context.attendanceScope, {
        memberId: context.memberId, programId: context.programId, classesOnly: true,
        since: context.promotedAt ?? '1970-01-01T00:00:00.000Z', until: context.clock.now().toISOString(),
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
      const today = context.clock.now().toISOString().slice(0, 10);
      const current = Math.max(0, Number(today.slice(0, 4)) - Number(context.dateOfBirth.slice(0, 4))
        - (today.slice(5) < context.dateOfBirth.slice(5) ? 1 : 0));
      return progress(current, target);
    },
  });
  return registry;
}
