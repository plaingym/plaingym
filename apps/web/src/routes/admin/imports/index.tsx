// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { ImportsPage } from '../../../features/imports/page.js';

export const Route = createFileRoute('/admin/imports/')({ component: ImportsPage });
