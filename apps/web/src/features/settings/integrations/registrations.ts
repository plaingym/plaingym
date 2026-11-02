// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';
import { IntegrationsSettings } from './section.js';

export const registration: WebRegistration = {
  settingsSections: [{ id: 'settingsSections.settings.integrations', labelKey: 'settings/integrations:title',
    permission: { kind: 'staff', capability: 'integrations.manage' }, enabled: true, component: IntegrationsSettings }],
};
