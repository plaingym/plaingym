// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { SetupWizard } from '../../features/setup/wizard.js';

export const Route = createFileRoute('/setup/')({ component: SetupWizard });
