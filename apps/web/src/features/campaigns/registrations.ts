// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';
import { MemberLinksTab } from './member-links.js';

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
  memberTabs: [
    {
      id: 'memberTabs.links',
      labelKey: 'links/member-links:tab',
      permission: { kind: 'staff', capability: 'links.send' },
      enabled: true,
      component: MemberLinksTab,
    },
  ],
};
