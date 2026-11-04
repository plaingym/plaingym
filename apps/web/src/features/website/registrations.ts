// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';
import { WebsiteSettings } from './settings.js';

/** Shown only while the gym has the website module on, like the module's routes. */
export const registration: WebRegistration = {
  settingsSections: [
    {
      id: 'settingsSections.website',
      labelKey: 'website/website:title',
      permission: { kind: 'staff', capability: 'settings.manage' },
      enabled: true,
      moduleId: 'website',
      component: WebsiteSettings,
    },
  ],
};
