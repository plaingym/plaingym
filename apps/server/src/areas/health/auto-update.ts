// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { auditEvents, forGym, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import { createTranslator, type Clock } from '@plaingym/shared';
import { automaticUpdatesHealthDetailsSchema, instantSchema, type AutomaticUpdatesHealthDetails, type HealthTile } from '@plaingym/shared/contracts';
import messages from '../../../../../locales/en/health/auto-update.json' with { type: 'json' };
import { tenancyMode, type TenancyMode } from '../../core/tenancy.js';
import { createAutoUpdateSettings, type AutoUpdateSettings } from '../settings/auto-update.js';
import { healthProvider } from './status.js';
import type { StaffProviderContext } from '../../core/interfaces/extensions.js';

const t = createTranslator({ 'health/auto-update': messages });
export const autoUpdateMessage = (key: string, values?: Record<string, string>) => t('health/auto-update:' + key, values);
const message = autoUpdateMessage;
/** Each attempt the host's nightly updater reports is one audit row of the gym, newest last. */
export const autoUpdateAttemptAction = 'health.auto_update.attempted';
/** Why an attempt installed nothing (`skipped`), went back to the previous version (`rolled_back`) or left a problem (`failed`). */
export const autoUpdateReasons = {
  skipped: ['disabled', 'check_failed', 'backups_not_configured', 'restore_in_progress', 'no_signing_key', 'version_unknown',
    'release_list_unavailable', 'manifest_unavailable', 'manifest_invalid', 'signature_invalid', 'pull_failed', 'digest_mismatch',
    'image_check_failed', 'migration_in_patch', 'snapshot_failed', 'rolled_back_version'],
  rolled_back: ['startup_failed', 'health_check_failed', 'interrupted'],
  failed: ['rollback_failed'],
} as const;
type Reason = (typeof autoUpdateReasons)[keyof typeof autoUpdateReasons][number];
const allReasons = Object.values(autoUpdateReasons).flat() as [Reason, ...Reason[]];
/** A release version as images label it: `v1.2.3`, or a development build such as `0.0.0-dev`. */
export const autoUpdateVersionSchema = z.string().max(64).regex(/^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
/** What the host's updater reports about one attempt. Each result names exactly the facts it can know. */
export const autoUpdateAttemptSchema = z.strictObject({
  attemptedAt: instantSchema,
  result: z.enum(['up_to_date', 'updated', 'skipped', 'rolled_back', 'failed']),
  reason: z.enum(allReasons).nullable(),
  fromVersion: autoUpdateVersionSchema.nullable(),
  toVersion: autoUpdateVersionSchema.nullable(),
}).superRefine((value, context) => {
  const reasons: readonly string[] = value.result in autoUpdateReasons ? autoUpdateReasons[value.result as keyof typeof autoUpdateReasons] : [];
  if (reasons.length ? !value.reason || !reasons.includes(value.reason) : value.reason !== null)
    context.addIssue({ code: 'custom', path: ['reason'], message: 'The reason does not fit the result' });
  const needsBoth = ['updated', 'rolled_back', 'failed'].includes(value.result);
  if ((needsBoth || value.result === 'up_to_date') && !value.fromVersion)
    context.addIssue({ code: 'custom', path: ['fromVersion'], message: 'The running version is required' });
  if (needsBoth ? !value.toVersion : value.result === 'up_to_date' && value.toVersion !== null)
    context.addIssue({ code: 'custom', path: ['toVersion'], message: 'The target version does not fit the result' });
});
export type AutoUpdateAttempt = z.infer<typeof autoUpdateAttemptSchema>;

export interface AutoUpdateOptions { scope?: typeof forGym; settings?: AutoUpdateSettings; tenancy?: TenancyMode;
  state?: (context: StaffProviderContext) => Promise<AutoUpdateState> }
/** Records and reads the host updater's attempts; the switch itself lives with the gym's settings. */
export function createAutoUpdateAttempts(options: Pick<AutoUpdateOptions, 'scope'> & { clock: Clock }) {
  const scope = options.scope ?? forGym;
  const latestRows = (tx: Transaction) => tx.select({ after: auditEvents.after }).from(auditEvents)
    .where(and(eq(auditEvents.action, autoUpdateAttemptAction), eq(auditEvents.targetType, 'auto_update')))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.targetId)).limit(5);
  async function recent(gymId: string): Promise<AutoUpdateAttempt[]> {
    const rows = await scope(gymId, latestRows);
    const seen = new Set<string>();
    return rows.flatMap(row => {
      const parsed = autoUpdateAttemptSchema.safeParse(row.after);
      if (!parsed.success || seen.has(parsed.data.attemptedAt)) return [];
      seen.add(parsed.data.attemptedAt);
      return [parsed.data];
    });
  }
  return {
    recent,
    /**
     * The host sends a report again until the command succeeds (an owner notice that wasn't accepted fails it), so a
     * replay of a recent attempt (same instant) records nothing new. The host's update lock runs one report at a time.
     */
    async record(gymId: string, input: AutoUpdateAttempt): Promise<AutoUpdateAttempt> {
      const attempt = autoUpdateAttemptSchema.parse(input), now = options.clock.now();
      await scope(gymId, async (tx) => {
        const replay = (await latestRows(tx)).some(row => autoUpdateAttemptSchema.safeParse(row.after).data?.attemptedAt === attempt.attemptedAt);
        if (!replay) await writeAudit(tx, { gymId, actorKind: 'system', action: autoUpdateAttemptAction,
          targetType: 'auto_update', targetId: uuidv7(now.getTime()), after: attempt, occurredAt: now });
      });
      return attempt;
    },
    /** The latest recorded attempt; a row that no longer parses is skipped rather than failing the tile. */
    async latest(gymId: string): Promise<AutoUpdateAttempt | null> {
      return (await recent(gymId))[0] ?? null;
    },
  };
}
/** Hours without a reported attempt before the tile asks the owner to check the server's timer. */
export const staleAfterHours = 50;
/** Releases the updater refuses on purpose: installing one by hand would skip the checks that refused it. */
const refusedReasons: readonly string[] = ['signature_invalid', 'digest_mismatch', 'manifest_invalid', 'migration_in_patch'];
type Tile = Extract<HealthTile, { id: 'automatic_updates' }>;
/** The owner's switch and the host updater's latest reported attempt: what decides whether a newer patch installs by itself. */
export interface AutoUpdateState { enabled: boolean; attempt: AutoUpdateAttempt | null;
  previousAttempt?: AutoUpdateAttempt | null; firstSeen?: string; timezone?: string }
const transientReasons: readonly string[] = ['release_list_unavailable', 'manifest_unavailable', 'pull_failed', 'snapshot_failed', 'check_failed'];
const transient = (attempt: AutoUpdateAttempt | null | undefined) => attempt?.result === 'skipped' && transientReasons.includes(attempt.reason ?? '');
export function formatAutoUpdateTime(instant: string, timezone = 'UTC'): string {
  return new Intl.DateTimeFormat('en', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(instant));
}
function staleMessage(state: AutoUpdateState) {
  return state.attempt ? message('tile.stale', { time: formatAutoUpdateTime(state.attempt.attemptedAt, state.timezone) }) : message('tile.neverRunStale');
}
/**
 * Where the nightly update stands, as one verdict that both the Automatic updates tile and the update banner read:
 * `off` (the owner's switch), `never_run`, `stale` (no attempt for {@link staleAfterHours}: the timer is missing or stopped),
 * `resumed` (turned back on after a night it was off: the next check simply hasn't run), `ok` (nothing newer, or installed),
 * or `problem` (the last attempt skipped, rolled back or failed).
 */
export type AttemptVerdict = 'off' | 'never_run' | 'stale' | 'resumed' | 'ok' | 'problem';
export function classifyAttempt(state: AutoUpdateState, now: Date): AttemptVerdict {
  const attempt = state.attempt;
  if (!state.enabled) return 'off';
  if (!attempt) return state.firstSeen && now.getTime() - Date.parse(state.firstSeen) > staleAfterHours * 3_600_000 ? 'stale' : 'never_run';
  if (now.getTime() - Date.parse(attempt.attemptedAt) > staleAfterHours * 3_600_000) return 'stale';
  if (attempt.result === 'up_to_date' || attempt.result === 'updated') return 'ok';
  return attempt.result === 'skipped' && attempt.reason === 'disabled' ? 'resumed' : 'problem';
}
export function describeAttempt(enabled: boolean, attempt: AutoUpdateAttempt | null, now: Date, metadata: Omit<AutoUpdateState, 'enabled' | 'attempt'> = {}): Pick<Tile, 'status' | 'message'> {
  const state = { ...metadata, enabled, attempt }, verdict = classifyAttempt(state, now);
  if (verdict === 'off') return { status: 'not_configured', message: message('tile.off') };
  if (verdict === 'stale') {
    const error = attempt?.result === 'failed' || (attempt?.result === 'skipped' && refusedReasons.includes(attempt.reason ?? ''));
    if (error && attempt) {
      const last = describeAttempt(enabled, attempt, new Date(attempt.attemptedAt), metadata);
      return { status: 'error', message: last.message + (last.message.endsWith('.') ? ' ' : '. ') + staleMessage(state) };
    }
    return { status: 'warning', message: staleMessage(state) };
  }
  if (!attempt) return { status: 'not_configured', message: message('tile.neverRun') };
  const versions = { from: attempt.fromVersion ?? '', to: attempt.toVersion ?? '' };
  const reason = attempt.reason ? message('reason.' + attempt.reason) : '';
  switch (attempt.result) {
    case 'up_to_date': return { status: 'healthy', message: message('tile.upToDate', { version: versions.from }) };
    case 'updated': return { status: 'healthy', message: message('tile.updated', versions) };
    case 'rolled_back': return { status: 'warning', message: message('tile.rolledBack', { ...versions, reason }) };
    case 'failed': return { status: 'error', message: message('tile.failed', { ...versions, reason }) };
    case 'skipped':
      // Turned back on after a night it was off: nothing is wrong, the next check simply hasn't run.
      if (verdict === 'resumed') return { status: 'not_configured', message: message('tile.resumed') };
      return { status: refusedReasons.includes(attempt.reason ?? '') ? 'error' : 'warning',
        message: message(attempt.toVersion ? 'tile.skippedTarget' : 'tile.skipped', { ...versions, reason }) };
  }
}
/** Reads one gym's switch and attempts, recording its first observation when needed. */
export function createAutoUpdateStateReader(options: Pick<AutoUpdateOptions, 'scope' | 'settings'> = {}) {
  const scope = options.scope ?? forGym;
  return async (gymId: string, clock: Clock): Promise<AutoUpdateState> => {
    const settings = options.settings ?? createAutoUpdateSettings({ scope, clock });
    const [setting, attempts, firstSeen] = await Promise.all([settings.get(gymId), createAutoUpdateAttempts({ scope, clock }).recent(gymId), settings.firstSeen(gymId)]);
    return { enabled: setting.enabled, timezone: setting.timezone, firstSeen, attempt: attempts[0] ?? null, previousAttempt: attempts[1] ?? null };
  };
}
/** The health service passes the same context to both tiles; a new request gets a fresh read. */
export function createRequestAutoUpdateStateReader(read = createAutoUpdateStateReader()) {
  const requests = new WeakMap<StaffProviderContext, Promise<AutoUpdateState>>();
  return (context: StaffProviderContext) => {
    let result = requests.get(context);
    if (!result) { result = read(context.gymId, context.clock); requests.set(context, result); }
    return result;
  };
}
export const requestAutoUpdateState = createRequestAutoUpdateStateReader();
/**
 * Why a newer patch release will not install by itself, as sentences that also say what to do, or null when tonight's check
 * is expected to install it. The owner's switch and a stopped timer hold every patch back, and the by-hand update is the
 * step. A skipped, rolled back or failed attempt holds back only the release it was about (`isOlder` says whether its
 * target is older than the newest release, which tonight's check tries instead); the reason says what to do, and for a
 * release the updater refused on purpose, not to install it by hand. A new install gets time for its first check.
 */
export function patchHoldReason(state: AutoUpdateState, now: Date, isOlder: (version: string) => boolean): string | null {
  const verdict = classifyAttempt(state, now), attempt = state.attempt;
  if (verdict === 'off') return message('tile.off') + ' ' + message('hold.byHand');
  if (verdict === 'stale') {
    const refused = attempt?.result === 'skipped' && refusedReasons.includes(attempt.reason ?? '') && (!attempt.toVersion || !isOlder(attempt.toVersion));
    return staleMessage(state) + ' ' + (refused ? message('reason.' + attempt.reason) + ' ' + message('hold.wait') : message('hold.byHand'));
  }
  if (verdict !== 'problem' || !attempt?.reason || (attempt.toVersion && isOlder(attempt.toVersion))) return null;
  if (transient(attempt) && !transient(state.previousAttempt)) return null;
  return message('reason.' + attempt.reason) + (refusedReasons.includes(attempt.reason) ? ' ' + message('hold.wait') : '');
}
/** The `automatic_updates` health tile: the owner's switch and the host updater's latest reported attempt. */
export function createAutoUpdateHealthProvider(options: AutoUpdateOptions = {}) {
  const readState = options.state ?? (options.scope || options.settings ? createRequestAutoUpdateStateReader(createAutoUpdateStateReader(options)) : requestAutoUpdateState);
  return healthProvider('automatic_updates', async (context) => {
    const checkedAt = context.clock.now().toISOString();
    if ((options.tenancy ?? tenancyMode()) === 'multi')
      return { id: 'automatic_updates', status: 'not_configured', checkedAt, details: null, message: message('tile.multi') };
    const state = await readState(context), { enabled, attempt } = state;
    const details: AutomaticUpdatesHealthDetails = automaticUpdatesHealthDetailsSchema.parse({ enabled,
      lastAttemptAt: attempt?.attemptedAt ?? null, result: attempt?.result ?? 'never_run',
      fromVersion: attempt?.fromVersion ?? null, toVersion: attempt?.toVersion ?? null });
    return { id: 'automatic_updates', checkedAt, details, ...describeAttempt(enabled, attempt, context.clock.now(), state) };
  });
}
