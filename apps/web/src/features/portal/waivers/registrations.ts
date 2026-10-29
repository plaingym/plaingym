// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';
import { PortalWaivers } from './page.js';

export const registration: WebRegistration = {
  portalNav: [
    {
      id: 'portalNav.waivers',
      labelKey: 'portal/waivers:title',
      permission: { kind: 'member', capability: 'waivers.self' },
      enabled: true,
      href: '/portal/waivers',
      order: 50,
    },
  ],
  portalPages: [
    {
      id: 'portalPages.waivers',
      labelKey: 'portal/waivers:title',
      permission: { kind: 'member', capability: 'waivers.self' },
      enabled: true,
      component: PortalWaivers,
    },
  ],
};
