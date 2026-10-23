// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  adminNav: [
    {
      id: 'adminNav.staff',
      labelKey: 'staff/profiles:title',
      permission: { kind: 'staff', capability: 'staff.manage' },
      enabled: true,
      href: '/admin/staff',
    },
  ],
};
