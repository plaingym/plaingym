// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { PortalBilling } from '../../../features/portal/billing/page.js';

export const Route = createFileRoute('/portal/billing/')({ component: PortalBilling });
