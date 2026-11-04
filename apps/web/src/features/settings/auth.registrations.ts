// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';
import { GoogleLoginSettings } from './auth.js';

export const registration: WebRegistration = {
  settingsSections: [
    {
      id: 'settingsSections.settings.auth',
      labelKey: 'auth/google:title',
      permission: { kind: 'staff', capability: 'integrations.manage' },
      // Renders nothing without Google sign-in; the settings page hides an empty section.
      enabled: true,
      component: GoogleLoginSettings,
    },
  ],
};
