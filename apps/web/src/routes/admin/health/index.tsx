// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { HealthPage } from '../../../features/health/page.js';
export const Route = createFileRoute('/admin/health/')({ component: HealthPage });
