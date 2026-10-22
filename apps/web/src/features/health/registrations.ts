// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  adminNav: [
    {
      id: 'adminNav.health',
      labelKey: 'health/status:title',
      permission: { kind: 'staff', capability: 'settings.manage' },
      enabled: true,
      href: '/admin/health',
    },
  ],
};
