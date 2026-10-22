// SPDX-License-Identifier: AGPL-3.0-only
import { createRootRoute, Outlet } from '@tanstack/react-router';

export const Route = createRootRoute({ component: Outlet });
