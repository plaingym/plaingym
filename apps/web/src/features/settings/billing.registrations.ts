// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';
import { BillingSettings } from './billing.js';
import { DropInSettings } from './drop-in.js';

export const registration: WebRegistration = {
  settingsSections: [{ id: 'settingsSections.settings.billing', labelKey: 'settings/billing:title',
    permission: { kind: 'staff', capability: 'settings.manage' }, enabled: true, component: BillingSettings },
  { id: 'settingsSections.settings.drop-in', labelKey: 'settings/drop-in:title',
    permission: { kind: 'staff', capability: 'settings.manage' }, enabled: true, component: DropInSettings }],
};
