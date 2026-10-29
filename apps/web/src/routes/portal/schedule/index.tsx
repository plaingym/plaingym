// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { PortalScheduleView } from '../../../features/portal/schedule/page.js';

export const Route = createFileRoute('/portal/schedule/')({ component: PortalScheduleView });
