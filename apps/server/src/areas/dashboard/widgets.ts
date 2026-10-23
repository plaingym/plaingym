// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, canStaff, Registry } from '@plaingym/shared';
import type { z } from 'zod';
import type { DashboardWidget } from '@plaingym/shared/contracts';
import type { DashboardWidgetProvider, StaffProviderContext } from '../../core/interfaces/extensions.js';

export interface DashboardContext extends StaffProviderContext {
  readonly enabledModules?: ReadonlySet<string>;
}

/** Both dashboard surfaces use the frozen provider interface and validate every payload. */
export function createWidgetRegistry<Widget extends DashboardWidget>(schema: z.ZodType<Widget>) {
  const registry = new Registry<DashboardWidgetProvider<Widget>>();
  const register = (provider: DashboardWidgetProvider<Widget>) => registry.register({
    id: provider.id, permission: provider.permission, schema: provider.schema,
    ...(provider.order === undefined ? {} : { order: provider.order }),
    ...(provider.moduleId === undefined ? {} : { moduleId: provider.moduleId }),
    read: (context) => provider.read(context),
  });
  return {
    register,
    registerAll: (providers: readonly DashboardWidgetProvider<Widget>[]) => providers.forEach(register),
    async read(context: DashboardContext): Promise<Widget[]> {
      const widgets: Widget[] = [];
      for (const provider of registry.forModules(context.enabledModules ?? new Set())) {
        // Check before calling the provider: forbidden widgets must perform no reads.
        if (!canStaff(context.roles, provider.permission)) continue;
        const widget = schema.parse(provider.schema.parse(await provider.read(context)));
        if (widget.id !== provider.id) throw new AppError('unavailable', 'Invalid dashboard widget');
        widgets.push(widget);
      }
      return widgets;
    },
  };
}
