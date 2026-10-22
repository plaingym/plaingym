// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';

export const registration: WebRegistration = {
  settingsSections: [
    {
      id: 'settingsSections.settings.general',
      labelKey: 'settings/settings:title',
      permission: { kind: 'staff', capability: 'settings.manage' },
      enabled: false,
      component: () => null,
    },
  ],
  adminNav: [
    {
      id: 'adminNav.settings',
      labelKey: 'settings/settings:title',
      permission: { kind: 'staff', capability: 'settings.manage' },
      enabled: false,
      href: '/admin/settings',
    },
  ],
};
