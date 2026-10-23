// SPDX-License-Identifier: AGPL-3.0-only
import type { KioskStandingCheck } from '../../core/interfaces/extensions.js';

/** Billing extension point; currently permits check-in without reading billing data. */
export const billingStanding: KioskStandingCheck = {
  id: 'billing',
  async check() { return { status: 'ok' }; },
};
