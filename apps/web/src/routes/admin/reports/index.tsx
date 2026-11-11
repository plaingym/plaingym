// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { ReportsPage } from '../../../features/reports/page.js';
export const Route = createFileRoute('/admin/reports/')({ component: ReportsPage });
