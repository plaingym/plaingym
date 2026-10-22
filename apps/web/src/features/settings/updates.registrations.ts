// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  settingsSections: [
    {
      id: 'settingsSections.settings.updates',
      labelKey: 'health/auto-update:title',
      permission: { kind: 'staff', capability: 'settings.manage' },
      enabled: false,
      component: () => null,
    },
  ],
};
