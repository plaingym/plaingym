// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';

export const registration: WebRegistration = {
  portalNav: [
    {
      id: 'portalNav.progress',
      labelKey: 'portal/progress:title',
      permission: { kind: 'member', capability: 'progress.read' },
      enabled: false,
      href: '/portal/progress',
    },
  ],
  portalPages: [
    {
      id: 'portalPages.progress',
      labelKey: 'portal/progress:title',
      permission: { kind: 'member', capability: 'progress.read' },
      enabled: false,
      component: () => null,
    },
  ],
};
