// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  memberTabs: [
    {
      id: 'memberTabs.checkin-code',
      labelKey: 'kiosk/qr:title',
      permission: { kind: 'staff', capability: 'members.manage' },
      enabled: false,
      component: () => null,
    },
  ],
};
