// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  memberTabs: [
    {
      id: 'memberTabs.bookings',
      labelKey: 'bookings/bookings:title',
      permission: { kind: 'staff', capability: 'bookings.manage' },
      enabled: false,
      component: () => null,
    },
  ],
  sessionPanels: [
    {
      id: 'sessionPanels.bookings',
      labelKey: 'bookings/bookings:title',
      permission: { kind: 'staff', capability: 'bookings.manage' },
      enabled: false,
      component: () => null,
    },
  ],
};
