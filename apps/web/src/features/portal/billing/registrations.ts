// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';
import { PortalBilling } from './page.js';

export const registration: WebRegistration = {
  portalNav: [
    {
      id: 'portalNav.billing',
      labelKey: 'portal/billing:title',
      permission: { kind: 'member', capability: 'billing.manage' },
      enabled: true,
      href: '/portal/billing',
      order: 40,
    },
  ],
  portalPages: [
    {
      id: 'portalPages.billing',
      labelKey: 'portal/billing:title',
      permission: { kind: 'member', capability: 'billing.manage' },
      enabled: true,
      component: PortalBilling,
    },
  ],
};
