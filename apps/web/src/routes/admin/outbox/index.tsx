// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { OutboxPage } from '../../../features/demo/outbox.js';
export const Route = createFileRoute('/admin/outbox/')({ component: OutboxPage });
