// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  setupSteps: [
    {
      id: 'setupSteps.setup.import',
      labelKey: 'setup/import-step:title',
      permission: { kind: 'staff', capability: 'settings.manage' },
      enabled: false,
      component: () => null,
    },
  ],
};
