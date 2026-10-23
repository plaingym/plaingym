// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  adminNav: [
    {
      id: 'adminNav.dashboard',
      labelKey: 'dashboard/dashboard:title',
      permission: { kind: 'staff', capability: 'members.read' },
      enabled: true,
      href: '/admin',
    },
  ],
};
