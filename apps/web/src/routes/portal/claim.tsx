// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { PortalClaim } from '../../features/portal/shell/claim.js';
export const Route = createFileRoute('/portal/claim')({ component: PortalClaim });
