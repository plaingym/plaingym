// SPDX-License-Identifier: AGPL-3.0-only
import type { StaffRole } from '@plaingym/shared';
import type { DashboardView } from './widgets.js';

/** Billing providers register their views and load their own contracted dashboard. */
export const billingWidgetViews: readonly DashboardView[] = [];
export function BillingDashboardPanel(_props: { gymId: string; roles: readonly StaffRole[] }) {
  return null;
}
