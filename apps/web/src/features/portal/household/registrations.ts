// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';

export const registration: WebRegistration = {
  portalNav: [
    {
      id: 'portalNav.household',
      labelKey: 'portal/household:title',
      permission: { kind: 'member', capability: 'household.read' },
      enabled: false,
      href: '/portal/household',
    },
  ],
  portalPages: [
    {
      id: 'portalPages.household',
      labelKey: 'portal/household:title',
      permission: { kind: 'member', capability: 'household.read' },
      enabled: false,
      component: () => null,
    },
  ],
};
