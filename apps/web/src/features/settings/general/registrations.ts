// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';
import { GeneralSettingsForm } from './form.js';
export const registration: WebRegistration = {
  settingsSections: [{ id: 'settingsSections.settings.general', labelKey: 'settings/settings:general',
    permission: { kind: 'staff', capability: 'settings.manage' }, enabled: true, component: GeneralSettingsForm }],
  adminNav: [{ id: 'adminNav.settings', labelKey: 'settings/settings:title',
    permission: { kind: 'staff', capability: 'settings.manage' }, enabled: true, href: '/admin/settings' }],
};
