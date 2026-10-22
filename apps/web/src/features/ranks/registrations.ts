// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';
import { MemberRanksTab } from './member-tab.js';

export const registration: WebRegistration = {
  adminNav: [
    {
      id: 'adminNav.ranks',
      labelKey: 'ranks/ranks:title',
      permission: { kind: 'staff', capability: 'members.read' },
      enabled: true,
      href: '/admin/ranks',
    },
  ],
  memberTabs: [
    {
      id: 'memberTabs.ranks',
      labelKey: 'ranks/ranks:title',
      permission: { kind: 'staff', capability: 'members.read' },
      enabled: true,
      component: MemberRanksTab,
    },
  ],
};
