// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';
import { WebsiteSettings } from './settings.js';

/** Owners can prepare the website before enabling its public pages. */
export const registration: WebRegistration = {
  settingsSections: [
    {
      id: 'settingsSections.website',
      labelKey: 'website/website:title',
      permission: { kind: 'staff', capability: 'settings.manage' },
      enabled: true,
      component: WebsiteSettings,
    },
  ],
};
