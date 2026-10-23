// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';
import { KioskStandingTab } from './standing.js';

export const registration: WebRegistration = {
  memberTabs: [
    {
      id: 'memberTabs.kiosk-standing',
      labelKey: 'kiosk/standing:title',
      permission: { kind: 'staff', capability: 'members.read' },
      enabled: true,
      component: KioskStandingTab,
    },
  ],
};
