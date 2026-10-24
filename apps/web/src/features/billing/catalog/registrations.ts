// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';

export const registration: WebRegistration = {
  adminNav: [
    {
      id: 'adminNav.billing.plans',
      labelKey: 'billing/catalog:title',
      permission: { kind: 'staff', capability: 'plans.manage' },
      enabled: true,
      href: '/admin/billing/plans',
    },
  ],
};
