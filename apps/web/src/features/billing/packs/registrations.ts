// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';
import { PacksTab } from './member-tab.js';

export const registration: WebRegistration = {
  memberTabs: [{ id: 'memberTabs.packs', labelKey: 'billing/pack-screens:tabTitle',
    permission: { kind: 'staff', capability: 'billing.read' }, enabled: true, component: PacksTab }],
};
