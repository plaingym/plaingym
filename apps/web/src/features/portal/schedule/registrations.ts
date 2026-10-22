// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';

export const registration: WebRegistration = {
  portalNav: [
    {
      id: 'portalNav.schedule',
      labelKey: 'portal/schedule:title',
      permission: { kind: 'member', capability: 'bookings.self' },
      enabled: false,
      href: '/portal/schedule',
    },
  ],
  portalPages: [
    {
      id: 'portalPages.schedule',
      labelKey: 'portal/schedule:title',
      permission: { kind: 'member', capability: 'bookings.self' },
      enabled: false,
      component: () => null,
    },
  ],
};
