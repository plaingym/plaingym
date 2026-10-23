// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { KioskApp } from '../../features/kiosk/kiosk.js';

export const Route = createFileRoute('/kiosk/')({ component: KioskApp });
