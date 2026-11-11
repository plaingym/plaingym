// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';
export const registration: WebRegistration = {
  adminNav: [{ id: 'adminNav.reports', labelKey: 'reports/screens:title',
    permission: { kind: 'staff', capability: 'reports.read' }, enabled: true, href: '/admin/reports' }],
};
