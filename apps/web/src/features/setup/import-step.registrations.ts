// SPDX-License-Identifier: AGPL-3.0-only
import { createElement } from 'react';
import type { WebRegistration } from '../../lib/registries.js';
import { ImportStep } from './import-step.js';

export const registration: WebRegistration = {
  setupSteps: [
    {
      id: 'setupSteps.setup.import',
      labelKey: 'setup/import-step:title',
      permission: { kind: 'staff', capability: 'settings.manage' },
      enabled: true,
      component: () => createElement(ImportStep),
    },
  ],
};
