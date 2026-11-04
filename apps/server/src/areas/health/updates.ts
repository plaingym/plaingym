// SPDX-License-Identifier: AGPL-3.0-only
import release from '../../../../../package.json' with { type: 'json' };
import { createTranslator, type Translator } from '@plaingym/shared';
import messages from '../../../../../locales/en/health/updates.json' with { type: 'json' };
import type { UpdateAvailableHealthDetails } from '@plaingym/shared/contracts';
import { healthProvider } from './status.js';

const translate = createTranslator({ 'health/updates': messages });
const message = (key: string, values?: Parameters<Translator>[1]) => translate('health/updates:' + key, values);

/** The public releases list; no token is sent, so GitHub's anonymous limit applies (one request a day is far below it). */
export const releasesApiUrl = 'https://api.github.com/repos/plaingym/plaingym/releases/latest';
const releasePageOrigin = 'https://github.com/';
const day = 24 * 60 * 60 * 1000, hour = 60 * 60 * 1000;
const maxBodyBytes = 256 * 1024;

export interface Semver { major: number; minor: number; patch: number }
/** Only plain `X.Y.Z` (with an optional leading `v`) counts as a release; pre-release and build suffixes do not. */
export function parseVersion(value: string): Semver | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value.trim());
  if (!match) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  return [major, minor, patch].every(Number.isSafeInteger) ? { major, minor, patch } : null;
}
export function compareVersions(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}
/** A newer minor or major waits for the owner; a newer patch applies by itself (and never raises the banner). */
export function updateKind(current: Semver, latest: Semver): 'none' | 'patch' | 'minor' | 'major' {
  if (compareVersions(latest, current) <= 0) return 'none';
  return latest.major > current.major ? 'major' : latest.minor > current.minor ? 'minor' : 'patch';
}

export interface LatestRelease { version: string; url: string; checkedAt: Date }
export interface ReleaseCheck {
  /** The newest release this install has seen, or null while none has been read. Never throws. */
  latest(now: Date): Promise<LatestRelease | null>;
}
export interface ReleaseCheckOptions {
  fetch?: typeof fetch;
  url?: string;
  /** How long a good answer is kept before the next request. */
  ttlMs?: number;
  /** How long to wait after a failed request. A failure keeps serving the last good answer. */
  retryMs?: number;
  timeoutMs?: number;
}
/**
 * Reads the newest published release at most once a day. A failed or malformed answer (offline, rate limited, GitHub down)
 * keeps the last good one and retries after an hour, so the admin never waits on, or breaks from, the network: a request
 * that finds a cached answer returns it at once and refreshes in the background.
 */
export function createReleaseCheck(options: ReleaseCheckOptions = {}): ReleaseCheck {
  const fetcher = options.fetch ?? fetch, url = options.url ?? releasesApiUrl;
  const ttl = options.ttlMs ?? day, retry = options.retryMs ?? hour, timeout = options.timeoutMs ?? 5000;
  let known: LatestRelease | null = null, nextAt = 0, pending: Promise<void> | null = null;
  async function refresh(now: Date) {
    try {
      const response = await fetcher(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'plaingym-update-check' },
        redirect: 'error', signal: AbortSignal.timeout(timeout) });
      if (!response.ok) throw new Error('Release list answered ' + response.status);
      const text = await response.text();
      if (text.length > maxBodyBytes) throw new Error('Release answer too large');
      const body = JSON.parse(text) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
      if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string' || body.draft === true || body.prerelease === true) throw new Error('Unusable release');
      const version = parseVersion(body.tag_name), page = new URL(body.html_url);
      if (!version || page.origin + '/' !== releasePageOrigin) throw new Error('Unusable release');
      known = { version: `${version.major}.${version.minor}.${version.patch}`, url: page.href, checkedAt: now };
      nextAt = now.getTime() + ttl;
    } catch {
      nextAt = now.getTime() + retry;
    }
  }
  return { async latest(now) {
    if (now.getTime() >= nextAt) {
      pending ??= refresh(now).finally(() => { pending = null; });
      // With nothing cached the caller waits for the first answer; otherwise it gets the cached one now.
      if (!known) await pending;
    }
    return known;
  } };
}
let shared: ReleaseCheck | undefined;
/** One check per process, so the health page, the banner route and the tile share a single daily request. */
export function sharedReleaseCheck(): ReleaseCheck { return shared ??= createReleaseCheck(); }

export interface UpdateProviderOptions { env?: NodeJS.ProcessEnv; check?: ReleaseCheck }
/**
 * Update checks run only on a self-hosted install, and `UPDATE_CHECK=off` turns them off for an air-gapped one. Only unset,
 * empty, `on`, `true` or `1` leave it on: a value the app doesn't know (a typo, `no`) never calls out.
 */
export function updateCheckEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.TENANCY !== 'multi' && ['', 'on', 'true', '1'].includes((env.UPDATE_CHECK ?? '').trim().toLowerCase());
}
export function createUpdateAvailableProvider(options: UpdateProviderOptions = {}) {
  const env = options.env ?? process.env;
  return healthProvider('update_available', async (context) => {
    const now = context.clock.now(), checkedAt = now.toISOString();
    const empty = (status: 'not_configured' | 'unavailable', key: string) =>
      ({ id: 'update_available' as const, status, checkedAt: status === 'unavailable' ? checkedAt : null, details: null, message: message(key) });
    if (!updateCheckEnabled(env)) return empty('not_configured', 'off');
    const running = (env.APP_VERSION ?? release.version).trim(), current = parseVersion(running);
    if (!current) return empty('not_configured', 'notRelease');
    const latest = await (options.check ?? sharedReleaseCheck()).latest(now);
    if (!latest) return empty('unavailable', 'unreachable');
    const newest = parseVersion(latest.version)!, kind = updateKind(current, newest), ahead = compareVersions(current, newest) > 0;
    const details: UpdateAvailableHealthDetails = { currentVersion: `${current.major}.${current.minor}.${current.patch}`,
      latestVersion: latest.version, available: kind === 'minor' || kind === 'major', releaseUrl: latest.url };
    const values = { current: details.currentVersion, latest: latest.version };
    return { id: 'update_available' as const, checkedAt: latest.checkedAt.toISOString(), details,
      status: details.available ? 'warning' as const : 'healthy' as const,
      message: message(details.available ? 'available' : kind === 'patch' ? 'patch' : ahead ? 'ahead' : 'current', values) };
  });
}
