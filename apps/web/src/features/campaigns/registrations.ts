// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  adminNav: [
    {
      id: 'adminNav.campaigns',
      labelKey: 'links/campaigns:title',
      permission: { kind: 'staff', capability: 'links.send' },
      enabled: true,
      href: '/admin/campaigns',
    },
  ],
};
