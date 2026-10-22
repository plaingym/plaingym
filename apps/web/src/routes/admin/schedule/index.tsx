// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { SchedulePage } from '../../../features/schedule/page.js';

export const Route = createFileRoute('/admin/schedule/')({ component: SchedulePage });
