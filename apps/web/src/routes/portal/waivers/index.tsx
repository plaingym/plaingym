// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { PortalWaivers } from '../../../features/portal/waivers/page.js';

export const Route = createFileRoute('/portal/waivers/')({ component: PortalWaivers });
