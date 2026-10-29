// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { PortalShell } from '../../features/portal/shell/shell.js';

export const Route = createFileRoute('/portal')({ component: PortalShell });
