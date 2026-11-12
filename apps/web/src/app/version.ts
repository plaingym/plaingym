// SPDX-License-Identifier: AGPL-3.0-only
declare const __BUILD_INFO__: { version: string; commit: string };
export const clientVersion = typeof __BUILD_INFO__ === 'undefined' ? null : __BUILD_INFO__;

type FollowOptions = {
  built?: { version: string; commit: string } | null;
  request?: typeof fetch;
  destination?: string;
  reload?: (destination: string) => void;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
};

/**
 * The root route's check. Hovering a link preloads its route, which must not reload the page under an
 * open form. `pnpm dev` runs two processes that compute the version apart, so the guard stays off there.
 */
let lastCheck = -Infinity;
let checking = false;
export function checkOnNavigation({ preload, location }: { preload: boolean; location: { href: string } }, options: FollowOptions & { development?: boolean } = {}) {
  if (preload || (options.development ?? import.meta.env.DEV)) return;
  const now = Date.now();
  if (checking || now - lastCheck < 60_000) return;
  checking = true;
  return followServerVersion({ ...options, destination: location.href }, () => { lastCheck = Date.now(); })
    .finally(() => { checking = false; });
}

function reloadDestination(destination: string) {
  const current = new URL(window.location.href), target = new URL(destination, current);
  if (current.origin === target.origin && current.pathname === target.pathname && current.search === target.search) {
    // Assigning only a fragment leaves the old bundle running, even if the fragment is unchanged.
    window.location.hash = target.hash;
    window.location.reload();
  } else window.location.assign(destination);
}

/** Shared root navigation guard covers admin, portal (including the installed PWA), and kiosk. */
export async function followServerVersion(options: FollowOptions = {}, received: () => void = () => undefined): Promise<void> {
  const built = options.built === undefined ? clientVersion : options.built;
  if (!built) return;
  const request = options.request ?? fetch;
  let remote: unknown;
  try {
    const response = await request('/healthz', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(1000) });
    if (!response.ok) return;
    remote = await response.json();
  } catch { return; } // A network failure does not erase the current page.
  if (!remote || typeof remote !== 'object' || !('version' in remote) || typeof remote.version !== 'string' ||
    !('commit' in remote) || typeof remote.commit !== 'string') return;
  received();
  const storage = options.storage ?? sessionStorage, key = 'plaingym-version-reload';
  if (remote.version === built.version && remote.commit === built.commit) { storage.removeItem(key); return; }
  const target = `${remote.version}:${remote.commit}`;
  if (storage.getItem(key) === target) throw new Error('The page could not load the server version');
  storage.setItem(key, target);
  (options.reload ?? reloadDestination)(options.destination ?? window.location.href);
}
