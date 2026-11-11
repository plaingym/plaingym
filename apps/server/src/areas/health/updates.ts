// SPDX-License-Identifier: AGPL-3.0-only
import { runningVersion } from './version.js';
import { createTranslator, type Clock, type Translator } from '@plaingym/shared';
import messages from '../../../../../locales/en/health/updates.json' with { type: 'json' };
import type { UpdateAvailableHealthDetails } from '@plaingym/shared/contracts';
import { requestAutoUpdateState, autoUpdateMessage, patchHoldReason, type AutoUpdateState } from './auto-update.js';
import { healthProvider } from './status.js';
import type { StaffProviderContext } from '../../core/interfaces/extensions.js';

const translate = createTranslator({ 'health/updates': messages });
const message = (key: string, values?: Parameters<Translator>[1]) => translate('health/updates:' + key, values);

/** The repository whose releases are read unless `RELEASE_REPOSITORY`, the one the updater follows, names another. */
export const defaultRepository = 'plaingym/plaingym';
/** The shape the updater accepts for `RELEASE_REPOSITORY`: `owner/name`. */
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** The public releases list of a repository; no token is sent, so GitHub's anonymous limit applies (one request a day is far below it). */
export const releasesApiUrlFor = (repository: string) => `https://api.github.com/repos/${repository}/releases/latest`;
export const releasesApiUrl = releasesApiUrlFor(defaultRepository);
const releasePageOrigin = 'https://github.com/';
const day = 24 * 60 * 60 * 1000, hour = 60 * 60 * 1000;
const maxBodyBytes = 256 * 1024;

/** The repository named by `RELEASE_REPOSITORY` (unset or empty means the default), or null when it isn't `owner/name`. */
export function releaseRepository(env: NodeJS.ProcessEnv): string | null {
  const value = (env.RELEASE_REPOSITORY ?? '').trim() || defaultRepository;
  return repositoryPattern.test(value) && value.split('/').every(part => !/^\.+$/.test(part)) ? value : null;
}

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
/** A development build is versioned `0.0.0`; it is not a release and has nothing to compare with. */
const isDevelopmentBuild = (version: Semver) => version.major === 0 && version.minor === 0 && version.patch === 0;
/** A newer minor or major waits for the owner; a newer patch applies by itself unless the nightly updater is held back. */
export function updateKind(current: Semver, latest: Semver): 'none' | 'patch' | 'minor' | 'major' {
  if (compareVersions(latest, current) <= 0) return 'none';
  return latest.major > current.major ? 'major' : latest.minor > current.minor ? 'minor' : 'patch';
}

export interface LatestRelease { version: string; url: string; checkedAt: Date }
export interface ReleaseCheck {
  /**
   * The newest release this install has seen, or null while none has been read. Never throws and never waits for the
   * network: a read that finds nothing cached starts the request in the background and answers null.
   */
  latest(now: Date): Promise<LatestRelease | null>;
  /** When the last request failed, if it did and no request has succeeded since; null while the first one is still running. */
  failedAt?(): Date | null;
}
export interface ReleaseCheckOptions {
  fetch?: typeof fetch;
  /** The repository whose releases are read, as `owner/name`. */
  repository?: string;
  url?: string;
  /** How long a good answer is kept before the next request. */
  ttlMs?: number;
  /** How long to wait after a failed request. A failure keeps serving the last good answer. */
  retryMs?: number;
  timeoutMs?: number;
}
/** The whole body as text, refusing an answer over `limit` bytes: by its declared length, or as soon as the stream passes it. */
async function readLimited(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) { await response.body?.cancel().catch(() => undefined); throw new Error('Release answer too large'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Release answer has no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => undefined); throw new Error('Release answer too large'); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
/**
 * Reads the newest published release at most once a day. A failed or malformed answer (offline, rate limited, GitHub down)
 * keeps the last good one and retries after an hour, so the admin never waits on, or breaks from, the network: a request
 * returns what is cached at once (nothing, the first time) and refreshes in the background.
 */
export function createReleaseCheck(options: ReleaseCheckOptions = {}): ReleaseCheck {
  const fetcher = options.fetch ?? fetch, repository = options.repository ?? defaultRepository;
  const url = options.url ?? releasesApiUrlFor(repository);
  const ttl = options.ttlMs ?? day, retry = options.retryMs ?? hour, timeout = options.timeoutMs ?? 5000;
  // The release page must sit under the repository that was asked, so an answer can't point the link elsewhere.
  const pagePrefix = `/${repository}/releases/`.toLowerCase();
  let known: LatestRelease | null = null, failedAt: Date | null = null, nextAt = 0, pending: Promise<void> | null = null;
  async function refresh(now: Date) {
    try {
      const response = await fetcher(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'plaingym-update-check' },
        redirect: 'error', signal: AbortSignal.timeout(timeout) });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error('Release list answered ' + response.status); }
      const body = JSON.parse(await readLimited(response, maxBodyBytes)) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
      if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string' || body.draft === true || body.prerelease === true) throw new Error('Unusable release');
      const version = parseVersion(body.tag_name), page = new URL(body.html_url);
      if (!version || page.origin + '/' !== releasePageOrigin || !page.pathname.toLowerCase().startsWith(pagePrefix)) throw new Error('Unusable release');
      known = { version: `${version.major}.${version.minor}.${version.patch}`, url: page.href, checkedAt: now };
      failedAt = null;
      nextAt = now.getTime() + ttl;
    } catch {
      failedAt = now;
      nextAt = now.getTime() + retry;
    }
  }
  return {
    async latest(now) {
      if (now.getTime() >= nextAt) pending ??= refresh(now).finally(() => { pending = null; });
      return known;
    },
    failedAt: () => failedAt,
  };
}
const shared = new Map<string, ReleaseCheck>();
/** One check per repository per process, so the health page, the banner route and the tile share a single daily request. */
export function sharedReleaseCheck(repository = defaultRepository): ReleaseCheck {
  let check = shared.get(repository);
  if (!check) shared.set(repository, check = createReleaseCheck({ repository }));
  return check;
}

export interface UpdateProviderOptions {
  state?: (context: StaffProviderContext) => Promise<AutoUpdateState>;
  env?: NodeJS.ProcessEnv;
  check?: ReleaseCheck;
  /** The gym's automatic-update switch and last attempt; by default read from the database. */
  automatic?: (gymId: string, clock: Clock) => Promise<AutoUpdateState>;
}
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
    const now = context.clock.now();
    const empty = (status: 'not_configured' | 'unavailable', key: string, at: string | null = null) =>
      ({ id: 'update_available' as const, status, checkedAt: at, details: null, message: message(key) });
    if (!updateCheckEnabled(env)) return empty('not_configured', 'off');
    const running = runningVersion(env).version.trim(), current = parseVersion(running);
    if (!current || isDevelopmentBuild(current)) return empty('not_configured', 'notRelease');
    const repository = releaseRepository(env);
    if (!repository) return { id: 'update_available' as const, status: 'warning' as const, checkedAt: now.toISOString(),
      message: autoUpdateMessage('hold.badRepository'), details: { currentVersion: `${current.major}.${current.minor}.${current.patch}`, latestVersion: 'unknown', available: true, releaseUrl: null } };
    const check = options.check ?? sharedReleaseCheck(repository);
    let latest = await check.latest(now);
    if (!latest) {
      // Both answers are `unavailable`. Only the first request still running has no check time, which is what the banner waits on:
      // after a failure the check retries by itself each hour, and nothing needs asking sooner.
      const failedAt = check.failedAt?.() ?? null;
      return failedAt ? empty('unavailable', 'unreadable', failedAt.toISOString()) : empty('unavailable', 'unreachable');
    }
    const state = await (options.state ? options.state(context) : options.automatic ? options.automatic(context.gymId, context.clock) : requestAutoUpdateState(context)).catch(() => null);
    const target = state?.attempt?.toVersion ? parseVersion(state.attempt.toVersion) : null;
    if (target && compareVersions(target, parseVersion(latest.version)!) > 0) {
      const version = `${target.major}.${target.minor}.${target.patch}`;
      latest = { ...latest, version, url: `https://github.com/${repository}/releases/tag/v${version}` };
    }
    const newest = parseVersion(latest.version)!, kind = updateKind(current, newest), ahead = compareVersions(current, newest) > 0;
    // A newer patch installs itself, unless the owner turned that off or the nightly updater isn't getting it done.
    // Not knowing (the database didn't answer) keeps the quiet answer.
    const isOlder = (version: string) => { const target = parseVersion(version); return target !== null && compareVersions(target, newest) < 0; };
    const held = kind === 'patch' && state ? patchHoldReason(state, now, isOlder) : null;
    const details: UpdateAvailableHealthDetails = { currentVersion: `${current.major}.${current.minor}.${current.patch}`,
      latestVersion: latest.version, available: kind === 'minor' || kind === 'major' || held !== null, releaseUrl: latest.url };
    const values = { current: details.currentVersion, latest: latest.version, why: held ?? '' };
    return { id: 'update_available' as const, checkedAt: latest.checkedAt.toISOString(), details,
      status: details.available ? 'warning' as const : 'healthy' as const,
      message: message(held !== null ? 'patchHeld' : details.available ? 'available' : kind === 'patch' ? 'patch' : ahead ? 'ahead' : 'current', values) };
  });
}
