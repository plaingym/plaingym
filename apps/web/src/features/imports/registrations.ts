// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  adminNav: [
    {
      id: 'adminNav.imports',
      labelKey: 'imports/pipeline:title',
      permission: { kind: 'staff', capability: 'data.export' },
      enabled: false,
      href: '/admin/imports',
    },
  ],
};
