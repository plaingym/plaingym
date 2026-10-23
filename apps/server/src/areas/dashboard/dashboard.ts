// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, canStaff } from '@plaingym/shared';
import { matDashboardResponseSchema, matDashboardWidgetSchema, extensionDashboardWidgetSchema } from '@plaingym/shared/contracts';
import type { DashboardWidgetProvider } from '../../core/interfaces/extensions.js';
import { createMatWidgetProviders, type MatWidgetServices } from './mat.js';
import { createWidgetRegistry, type DashboardContext } from './widgets.js';

const schema = matDashboardWidgetSchema.or(extensionDashboardWidgetSchema);
export function createDashboardService(services: MatWidgetServices,
  providers: readonly DashboardWidgetProvider<ReturnType<typeof schema.parse>>[] = []) {
  const widgets = createWidgetRegistry(schema);
  widgets.registerAll([...createMatWidgetProviders(services), ...providers]);
  return {
    widgets,
    async get(context: DashboardContext) {
      if (!canStaff(context.roles, 'members.read')) throw new AppError('forbidden', 'Access denied');
      const now = context.clock.now();
      return matDashboardResponseSchema.parse({ data: { generatedAt: now.toISOString(),
        widgets: await widgets.read({ ...context, clock: { now: () => new Date(now) } }) } });
    },
  };
}
