// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';
import { WaiversTab } from './screens.js';

export const registration: WebRegistration = {
  adminNav: [
    {
      id: 'adminNav.waivers',
      labelKey: 'waivers/waivers:title',
      permission: { kind: 'staff', capability: 'members.manage' },
      enabled: true,
      href: '/admin/waivers',
    },
  ],
  memberTabs: [
    {
      id: 'memberTabs.waivers',
      labelKey: 'waivers/waivers:title',
      permission: { kind: 'staff', capability: 'members.read' },
      enabled: true,
      component: WaiversTab,
    },
  ],
};
