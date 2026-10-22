// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';

export const registration: WebRegistration = {
  portalNav: [
    {
      id: 'portalNav.waivers',
      labelKey: 'portal/waivers:title',
      permission: { kind: 'member', capability: 'waivers.self' },
      enabled: false,
      href: '/portal/waivers',
    },
  ],
  portalPages: [
    {
      id: 'portalPages.waivers',
      labelKey: 'portal/waivers:title',
      permission: { kind: 'member', capability: 'waivers.self' },
      enabled: false,
      component: () => null,
    },
  ],
};
