// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';
import { PortalHousehold } from './page.js';

// Payers manage the household; an adult member sees their own profile here.
export const registration: WebRegistration = {
  portalNav: [
    {
      id: 'portalNav.household',
      labelKey: 'portal/household:nav',
      permission: { kind: 'member', capability: 'profile.read' },
      enabled: true,
      href: '/portal/household',
      order: 60,
    },
  ],
  portalPages: [
    {
      id: 'portalPages.household',
      labelKey: 'portal/household:nav',
      permission: { kind: 'member', capability: 'profile.read' },
      enabled: true,
      component: PortalHousehold,
    },
  ],
};
