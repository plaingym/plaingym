// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  settingsSections: [
    {
      id: 'settingsSections.website',
      labelKey: 'website/website:title',
      permission: { kind: 'staff', capability: 'settings.manage' },
      enabled: false,
      moduleId: 'website',
      component: () => null,
    },
  ],
};
