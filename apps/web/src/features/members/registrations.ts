// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  adminNav: [
    {
      id: 'adminNav.members',
      labelKey: 'members/members:title',
      permission: { kind: 'staff', capability: 'members.read' },
      enabled: false,
      href: '/admin/members',
    },
  ],
};
