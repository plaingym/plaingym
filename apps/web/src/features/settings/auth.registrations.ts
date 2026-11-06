// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';
import { GoogleLoginSettings, googleSectionListed, useGoogleLogin } from './auth.js';

function useListed() {
  const google = useGoogleLogin(true);
  return google.isError || googleSectionListed(google.data);
}

export const registration: WebRegistration = {
  settingsSections: [
    {
      id: 'settingsSections.settings.auth',
      labelKey: 'auth/google:title',
      permission: { kind: 'staff', capability: 'integrations.manage' },
      // Renders nothing where the gym can't have Google sign-in (multi-gym or demo without an install client); the page hides an empty section.
      enabled: true,
      listed: useListed,
      component: GoogleLoginSettings,
    },
  ],
};
