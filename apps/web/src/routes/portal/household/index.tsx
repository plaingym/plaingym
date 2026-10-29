// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { PortalHousehold } from '../../../features/portal/household/page.js';

export const Route = createFileRoute('/portal/household/')({ component: PortalHousehold });
