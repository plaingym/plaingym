// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/setup')({ component: Outlet });
