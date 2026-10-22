// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';

export const registration: WebRegistration = {
  portalNav: [
    {
      id: 'portalNav.billing',
      labelKey: 'portal/billing:title',
      permission: { kind: 'member', capability: 'billing.manage' },
      enabled: false,
      href: '/portal/billing',
    },
  ],
  portalPages: [
    {
      id: 'portalPages.billing',
      labelKey: 'portal/billing:title',
      permission: { kind: 'member', capability: 'billing.manage' },
      enabled: false,
      component: () => null,
    },
  ],
};
