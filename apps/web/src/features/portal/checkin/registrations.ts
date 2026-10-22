// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';

export const registration: WebRegistration = {
  portalNav: [
    {
      id: 'portalNav.checkin',
      labelKey: 'portal/checkin:title',
      permission: { kind: 'member', capability: 'checkin.manage' },
      enabled: false,
      href: '/portal/checkin',
    },
  ],
  portalPages: [
    {
      id: 'portalPages.checkin',
      labelKey: 'portal/checkin:title',
      permission: { kind: 'member', capability: 'checkin.manage' },
      enabled: false,
      component: () => null,
    },
  ],
};
