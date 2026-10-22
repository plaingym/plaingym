// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  settingsSections: [
    {
      id: 'settingsSections.settings.go-live',
      labelKey: 'settings/go-live:title',
      permission: { kind: 'staff', capability: 'go_live.manage' },
      enabled: false,
      component: () => null,
    },
  ],
};
