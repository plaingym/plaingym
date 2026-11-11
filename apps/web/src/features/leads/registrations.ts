// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';
export const registration: WebRegistration = {
  adminNav: [{ id: 'adminNav.leads', labelKey: 'leads/screens:title',
    permission: { kind: 'staff', capability: 'leads.manage' }, enabled: true, href: '/admin/leads' }],
};
