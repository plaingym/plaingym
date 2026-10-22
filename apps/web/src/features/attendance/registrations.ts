// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  memberTabs: [
    {
      id: 'memberTabs.attendance',
      labelKey: 'attendance/attendance:title',
      permission: { kind: 'staff', capability: 'attendance.manage' },
      enabled: false,
      component: () => null,
    },
  ],
  sessionPanels: [
    {
      id: 'sessionPanels.attendance',
      labelKey: 'attendance/attendance:title',
      permission: { kind: 'staff', capability: 'attendance.manage' },
      enabled: false,
      component: () => null,
    },
  ],
};
