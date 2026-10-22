// SPDX-License-Identifier: AGPL-3.0-only
import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { routeTree } from '../routeTree.gen.js';
export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, defaultPreload: 'intent', ...(history ? { history } : {}) });
}
declare module '@tanstack/react-router' {
  interface Register { router: ReturnType<typeof createAppRouter> }
}
