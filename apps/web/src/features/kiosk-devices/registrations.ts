// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  settingsSections: [
    {
      id: 'settingsSections.kiosk.devices',
      labelKey: 'kiosk/devices:title',
      permission: { kind: 'staff', capability: 'kiosk_devices.manage' },
      enabled: false,
      component: () => null,
    },
  ],
};
