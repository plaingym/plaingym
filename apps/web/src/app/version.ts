// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';

declare const __BUILD_INFO__: { version: string; commit: string };
export const clientVersion = typeof __BUILD_INFO__ === 'undefined' ? null : __BUILD_INFO__;

// Keep in sync with scripts/release/version.mjs, which imports Node APIs.
export const releaseVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function releaseRepository(source: string): string | undefined {
  let url: URL;
  try { url = new URL(source); }
  catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2 && (segments.length !== 4 || segments[2] !== 'tree')) return undefined;
  const owner = segments[0], repo = segments[1]?.replace(/\.git$/, '');
  return owner && repo ? `${url.origin}/${owner}/${repo}` : undefined;
}

/** The label beside the footer's source link; a plain release links to its notes on the source repository. */
export function versionLabel(version: string, sourceUrl?: string): { text: string; href?: string } {
  if (!releaseVersionPattern.test(version)) return { text: version };
  const text = 'v' + version;
  const repository = sourceUrl === undefined ? undefined : releaseRepository(sourceUrl);
  return repository ? { text, href: `${repository}/releases/tag/${text}` } : { text };
}

async function loadSourceRepository(): Promise<string | undefined> {
  try {
    const response = await fetch('/api/source', { credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    if (!response.ok) return undefined;
    const body = await response.json() as { data?: { url?: unknown } } | null;
    return typeof body?.data?.url === 'string' ? body.data.url : undefined;
  } catch { return undefined; }
}

export function useSourceRepository(enabled: boolean): string | undefined {
  const [source, setSource] = useState<string>();
  // The same mount can run its effect twice in StrictMode.
  const request = useRef<Promise<string | undefined>>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    request.current ??= loadSourceRepository();
    void request.current.then(url => { if (active) setSource(url); });
    return () => { active = false; };
  }, [enabled]);
  return enabled ? source : undefined;
}

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
let nextCheck = -Infinity;
let checking: Promise<void> | undefined;
let reloadDeadline: number | undefined;
export const isVersionReloadPending = () => reloadDeadline !== undefined && performance.now() < reloadDeadline;
let stale = false;
const listeners = new Set<() => void>();
export const subscribeToStaleVersion = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const isStaleVersion = () => stale;
function markStale(value: boolean) {
  stale = value;
  for (const listener of listeners) listener();
}
/** Navigation and kiosk requests share one bounded check. A pending reload must still block credentials. */
export function checkServerVersion(options: FollowOptions = {}): Promise<void> | undefined {
  if (checking) return checking;
  if (isVersionReloadPending()) return;
  if (reloadDeadline === undefined && performance.now() < nextCheck) return;
  // An elapsed reload hold bypasses the normal throttle once.
  reloadDeadline = undefined;
  let answered = false;
  checking = followServerVersion(options, () => { answered = true; })
    .finally(() => { nextCheck = performance.now() + (answered ? 60_000 : 10_000); checking = undefined; });
  return checking;
}
export function checkOnNavigation({ preload, location }: { preload: boolean; location: { href: string } }, options: FollowOptions & { development?: boolean } = {}) {
  if (preload || (options.development ?? import.meta.env.DEV)) return;
  return checkServerVersion({ ...options, destination: location.href })?.catch(error => {
    // A tablet must still reach check-in after reloading stale assets; its strict API parsing remains active.
    if (stale && /^\/kiosk(?:[/?#]|$)/.test(location.href)) return;
    throw error;
  });
}

function reloadDestination(destination: string) {
  const current = new URL(window.location.href), target = new URL(destination, current);
  if (current.origin === target.origin && current.pathname === target.pathname && current.search === target.search) {
    // Assigning only a fragment leaves the old bundle running, even if the fragment is unchanged.
    if (target.hash) window.location.hash = target.hash;
    else window.history.replaceState(window.history.state, '', target.href);
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
  const matches = remote.version === built.version && remote.commit === built.commit;
  if (matches) markStale(false);
  // The notice is for a mismatch the reload cannot fix (blocked storage, a reload that failed or did not help), not
  // for the ordinary reload that follows a release.
  const unresolved = (error: unknown) => { reloadDeadline = undefined; markStale(true); return error; };
  const key = 'plaingym-version-reload', target = `${remote.version}:${remote.commit}`;
  try {
    const storage = options.storage ?? sessionStorage;
    if (matches) { reloadDeadline = undefined; storage.removeItem(key); return; }
    if (storage.getItem(key) === target) throw new Error('The page could not load the server version');
    storage.setItem(key, target);
  } catch (error) { throw matches ? error : unresolved(error); }
  reloadDeadline = performance.now() + 10_000;
  try { (options.reload ?? reloadDestination)(options.destination ?? window.location.href); }
  catch (error) { throw unresolved(error); }
}
