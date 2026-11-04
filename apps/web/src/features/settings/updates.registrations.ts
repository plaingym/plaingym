// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';
import { AutoUpdateSettings } from './updates.js';

export const registration: WebRegistration = {
  settingsSections: [
    {
      id: 'settingsSections.settings.updates',
      labelKey: 'health/auto-update:title',
      // Owners only, like the email, payment and backup settings: it decides what runs on the server.
      permission: { kind: 'staff', capability: 'integrations.manage' },
      enabled: true,
      component: AutoUpdateSettings,
    },
  ],
};
