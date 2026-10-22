// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  adminNav: [
    {
      id: 'adminNav.outbox',
      labelKey: 'demo/demo:title',
      permission: { kind: 'staff', capability: 'settings.manage' },
      enabled: false,
      href: '/admin/outbox',
    },
  ],
};
