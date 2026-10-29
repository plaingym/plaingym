// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { PortalProgressView } from '../../../features/portal/progress/page.js';

export const Route = createFileRoute('/portal/progress/')({ component: PortalProgressView });
