// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { WaiversPage } from '../../../features/waivers/screens.js';

export const Route = createFileRoute('/admin/waivers/')({ component: WaiversPage });
