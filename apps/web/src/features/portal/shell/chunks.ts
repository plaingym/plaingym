// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import { useRouter, type AnyRoute, type AnyRouter } from '@tanstack/react-router';

/** A split component keeps its `preload` until its code has loaded. */
const pending = (route: AnyRoute) => Boolean((route.options.component as { preload?: unknown } | undefined)?.preload);

/**
 * Loads the code of every portal section through the router's own loaders, and answers whether all of it loaded.
 * The router's split components swallow a failed import in `preload`, so a settled load alone doesn't show success.
 */
export async function warmPortalChunks(router: Pick<AnyRouter, 'routesById' | 'loadRouteChunk'>): Promise<boolean> {
  const routes = (Object.values(router.routesById) as AnyRoute[]).filter((route) => route.id.startsWith('/portal/'));
  const results = await Promise.allSettled(routes.map(async (route) => {
    await router.loadRouteChunk(route);
    if (pending(route)) throw new Error('Section code did not load');
  }));
  return results.every((result) => result.status === 'fulfilled');
}

/**
 * Loads the portal sections' code in the background while the browser is online, so a section first opened offline
 * doesn't need the network for it. A pass that fails runs again on the next `online` event.
 */
export function usePortalChunks() {
  const router = useRouter();
  const pass = useRef({ running: false, done: false, again: false });
  useEffect(() => {
    const state = pass.current;
    const warm = () => {
      if (!navigator.onLine || state.done) return;
      // A connection that returned during a pass counts if that pass fails.
      if (state.running) { state.again = true; return; }
      state.running = true;
      state.again = false;
      void warmPortalChunks(router).then((loaded) => {
        state.running = false;
        state.done = loaded;
        if (state.again) warm();
      });
    };
    warm();
    window.addEventListener('online', warm);
    return () => window.removeEventListener('online', warm);
  }, [router]);
}
