// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  settingsSections: [
    {
      id: 'settingsSections.settings.auth',
      labelKey: 'auth/google:title',
      permission: { kind: 'staff', capability: 'integrations.manage' },
      enabled: false,
      component: () => null,
    },
  ],
};
