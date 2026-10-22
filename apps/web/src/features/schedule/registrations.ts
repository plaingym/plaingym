// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  adminNav: [
    {
      id: 'adminNav.schedule',
      labelKey: 'schedule/schedule:title',
      permission: { kind: 'staff', capability: 'bookings.manage' },
      enabled: true,
      href: '/admin/schedule',
    },
  ],
};
