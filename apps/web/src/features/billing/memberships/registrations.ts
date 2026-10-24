// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';
import { MembershipTab } from './member-tab.js';

export const registration: WebRegistration = {
  memberTabs: [
    {
      id: 'memberTabs.membership',
      labelKey: 'billing/memberships:title',
      permission: { kind: 'staff', capability: 'billing.read' },
      enabled: true,
      component: MembershipTab,
    },
  ],
};
