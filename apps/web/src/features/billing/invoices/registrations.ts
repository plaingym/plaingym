// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';
import { InvoiceTab } from './page.js';

export const registration: WebRegistration = {
  adminNav: [
    {
      id: 'adminNav.billing.invoices',
      labelKey: 'billing/payments:title',
      permission: { kind: 'staff', capability: 'billing.read' },
      enabled: true,
      href: '/admin/billing/invoices',
    },
  ],
  memberTabs: [
    {
      id: 'memberTabs.invoices',
      labelKey: 'billing/payments:title',
      permission: { kind: 'staff', capability: 'billing.read' },
      enabled: true,
      component: InvoiceTab,
    },
  ],
};
