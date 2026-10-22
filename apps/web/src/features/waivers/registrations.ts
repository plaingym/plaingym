// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  adminNav: [
    {
      id: 'adminNav.waivers',
      labelKey: 'waivers/waivers:title',
      permission: { kind: 'staff', capability: 'members.manage' },
      enabled: false,
      href: '/admin/waivers',
    },
  ],
  memberTabs: [
    {
      id: 'memberTabs.waivers',
      labelKey: 'waivers/waivers:title',
      permission: { kind: 'staff', capability: 'members.read' },
      enabled: false,
      component: () => null,
    },
  ],
};
