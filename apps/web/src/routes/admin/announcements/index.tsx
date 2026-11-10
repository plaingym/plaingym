// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { AnnouncementPage } from '../../../features/announcements/page.js';
export const Route = createFileRoute('/admin/announcements/')({ component: AnnouncementPage });
