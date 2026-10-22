// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';

export const registration: WebRegistration = {
  setupSteps: [
    {
      id: 'setupSteps.setup.stripe',
      labelKey: 'setup/stripe-step:title',
      permission: { kind: 'staff', capability: 'integrations.manage' },
      enabled: false,
      component: () => null,
    },
  ],
};
