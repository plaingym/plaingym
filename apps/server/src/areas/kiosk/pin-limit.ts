// SPDX-License-Identifier: AGPL-3.0-only
import { and, countDistinct, eq, gt } from 'drizzle-orm';
import type { z } from '@hono/zod-openapi';
import { auditEvents, forGym, writeAudit } from '@plaingym/db';
import { AppError, canStaff } from '@plaingym/shared';
import { extensionDashboardWidgetSchema } from '@plaingym/shared/contracts';
import type { DashboardWidgetProvider } from '../../core/interfaces/extensions.js';

export const pinLimitReachedAction = 'kiosk.device.pin_limit_reached';
const day = 24 * 60 * 60 * 1000;

/** Each kiosk PIN guess spends the device's budget and its client address's budget (shared by kiosks behind one address). */
export type PinBudget = 'device' | 'address';
export interface PinLimitReached {
  readonly gymId: string;
  /** The device whose wrong PIN used up the budgets. */
  readonly deviceId: string;
  readonly limit: number;
  readonly budgets: readonly PinBudget[];
  readonly occurredAt: Date;
  readonly windowEndsAt: Date;
}
/** Audits a kiosk locked out of PIN check-in; the kiosk limiter calls it once per budget and window. */
export function createPinLimitAudit(options: { scope?: typeof forGym } = {}) {
  const scope = options.scope ?? forGym;
  return (event: PinLimitReached) => scope(event.gymId, async (tx) => {
    await writeAudit(tx, { gymId: event.gymId, actorKind: 'device', actorDeviceId: event.deviceId,
      action: pinLimitReachedAction, targetType: 'kiosk_device', targetId: event.deviceId,
      after: { limit: event.limit, budgets: event.budgets, windowEndsAt: event.windowEndsAt.toISOString() }, occurredAt: event.occurredAt });
  });
}

/**
 * Staff who manage kiosk devices see how many devices used up a PIN budget in the last 24 hours: their own, or the one
 * their address shares with other kiosks (only the device whose wrong PIN used it up is counted).
 */
export function createPinLimitWidgetProvider(options: { scope?: typeof forGym } = {}): DashboardWidgetProvider<z.infer<typeof extensionDashboardWidgetSchema>> {
  const scope = options.scope ?? forGym;
  return { id: 'kiosk.pin-limits', permission: 'kiosk_devices.manage', order: 50, schema: extensionDashboardWidgetSchema,
    async read(context) {
      if (!canStaff(context.roles, 'kiosk_devices.manage')) throw new AppError('forbidden', 'Access denied');
      const since = new Date(context.clock.now().getTime() - day);
      const [total] = await scope(context.gymId, (tx) => tx.select({ count: countDistinct(auditEvents.targetId) }).from(auditEvents)
        .where(and(eq(auditEvents.gymId, context.gymId), eq(auditEvents.action, pinLimitReachedAction), gt(auditEvents.occurredAt, since))));
      return { id: 'kiosk.pin-limits', titleKey: 'kiosk/devices:pinLimitTitle', status: 'ready', kind: 'count', count: total!.count };
    },
  };
}
