// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';

export const registration: WebRegistration = {
  memberTabs: [
    {
      id: 'memberTabs.portal-access',
      labelKey: 'portal/access:title',
      permission: { kind: 'staff', capability: 'portal_access.manage' },
      enabled: false,
      component: () => null,
    },
  ],
};
