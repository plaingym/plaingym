// SPDX-License-Identifier: AGPL-3.0-only
import { billingDashboardWidgetSchema } from '@plaingym/shared/contracts';
import { createWidgetRegistry } from './widgets.js';

/** Empty registration point: no billing metrics are fabricated before providers exist. */
export const createBillingWidgetRegistry = () => createWidgetRegistry(billingDashboardWidgetSchema);
