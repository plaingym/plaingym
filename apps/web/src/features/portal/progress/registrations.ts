// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';
import { PortalProgressView } from './page.js';

export const registration: WebRegistration = {
  portalNav: [
    {
      id: 'portalNav.progress',
      labelKey: 'portal/progress:title',
      permission: { kind: 'member', capability: 'progress.read' },
      enabled: true,
      href: '/portal/progress',
    },
  ],
  portalPages: [
    {
      id: 'portalPages.progress',
      labelKey: 'portal/progress:title',
      permission: { kind: 'member', capability: 'progress.read' },
      enabled: true,
      component: PortalProgressView,
    },
  ],
};
