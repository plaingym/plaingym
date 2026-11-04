// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { auditEvents, forGym, uuidv7, writeAudit } from '@plaingym/db';
import { createTranslator, type Clock } from '@plaingym/shared';
import { automaticUpdatesHealthDetailsSchema, instantSchema, type AutomaticUpdatesHealthDetails, type HealthTile } from '@plaingym/shared/contracts';
import messages from '../../../../../locales/en/health/auto-update.json' with { type: 'json' };
import { tenancyMode, type TenancyMode } from '../../core/tenancy.js';
import { createAutoUpdateSettings, type AutoUpdateSettings } from '../settings/auto-update.js';
import { healthProvider } from './status.js';

const t = createTranslator({ 'health/auto-update': messages });
const message = (key: string, values?: Record<string, string>) => t('health/auto-update:' + key, values);
/** Each attempt the host's nightly updater reports is one audit row of the gym, newest last. */
export const autoUpdateAttemptAction = 'health.auto_update.attempted';
/** Why an attempt installed nothing (`skipped`), went back to the previous version (`rolled_back`) or left a problem (`failed`). */
export const autoUpdateReasons = {
  skipped: ['disabled', 'check_failed', 'backups_not_configured', 'restore_in_progress', 'no_signing_key', 'version_unknown',
    'release_list_unavailable', 'manifest_unavailable', 'manifest_invalid', 'signature_invalid', 'pull_failed', 'digest_mismatch',
    'image_check_failed', 'migration_in_patch', 'snapshot_failed'],
  rolled_back: ['startup_failed', 'health_check_failed', 'interrupted'],
  failed: ['rollback_failed'],
} as const;
type Reason = (typeof autoUpdateReasons)[keyof typeof autoUpdateReasons][number];
const allReasons = Object.values(autoUpdateReasons).flat() as [Reason, ...Reason[]];
/** A release version as images label it: `v1.2.3`, or a development build such as `0.0.0-dev`. */
export const autoUpdateVersionSchema = z.string().max(64).regex(/^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/);
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

export interface AutoUpdateOptions { scope?: typeof forGym; settings?: AutoUpdateSettings; tenancy?: TenancyMode }
/** Records and reads the host updater's attempts; the switch itself lives with the gym's settings. */
export function createAutoUpdateAttempts(options: Pick<AutoUpdateOptions, 'scope'> & { clock: Clock }) {
  const scope = options.scope ?? forGym;
  return {
    async record(gymId: string, input: AutoUpdateAttempt): Promise<AutoUpdateAttempt> {
      const attempt = autoUpdateAttemptSchema.parse(input), now = options.clock.now();
      await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: autoUpdateAttemptAction,
        targetType: 'auto_update', targetId: uuidv7(now.getTime()), after: attempt, occurredAt: now }));
      return attempt;
    },
    /** The latest recorded attempt; a row that no longer parses is skipped rather than failing the tile. */
    async latest(gymId: string): Promise<AutoUpdateAttempt | null> {
      const rows = await scope(gymId, tx => tx.select({ after: auditEvents.after }).from(auditEvents)
        .where(and(eq(auditEvents.action, autoUpdateAttemptAction), eq(auditEvents.targetType, 'auto_update')))
        .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.targetId)).limit(5));
      for (const row of rows) {
        const parsed = autoUpdateAttemptSchema.safeParse(row.after);
        if (parsed.success) return parsed.data;
      }
      return null;
    },
  };
}
/** Hours without a reported attempt before the tile asks the owner to check the server's timer. */
export const staleAfterHours = 50;
const errorReasons: readonly string[] = ['signature_invalid', 'digest_mismatch', 'manifest_invalid', 'migration_in_patch'];
type Tile = Extract<HealthTile, { id: 'automatic_updates' }>;
export function describeAttempt(enabled: boolean, attempt: AutoUpdateAttempt | null, now: Date): Pick<Tile, 'status' | 'message'> {
  if (!enabled) return { status: 'not_configured', message: message('tile.off') };
  if (!attempt) return { status: 'not_configured', message: message('tile.neverRun') };
  const versions = { from: attempt.fromVersion ?? '', to: attempt.toVersion ?? '' };
  const reason = attempt.reason ? message('reason.' + attempt.reason) : '';
  if (now.getTime() - Date.parse(attempt.attemptedAt) > staleAfterHours * 3_600_000)
    return { status: 'warning', message: message('tile.stale', { time: attempt.attemptedAt }) };
  switch (attempt.result) {
    case 'up_to_date': return { status: 'healthy', message: message('tile.upToDate', { version: versions.from }) };
    case 'updated': return { status: 'healthy', message: message('tile.updated', versions) };
    case 'rolled_back': return { status: 'warning', message: message('tile.rolledBack', { ...versions, reason }) };
    case 'failed': return { status: 'error', message: message('tile.failed', { ...versions, reason }) };
    case 'skipped':
      // Turned back on after a night it was off: nothing is wrong, the next check simply hasn't run.
      if (attempt.reason === 'disabled') return { status: 'not_configured', message: message('tile.resumed') };
      return { status: errorReasons.includes(attempt.reason ?? '') ? 'error' : 'warning',
        message: message(attempt.toVersion ? 'tile.skippedTarget' : 'tile.skipped', { ...versions, reason }) };
  }
}
/** The `automatic_updates` health tile: the owner's switch and the host updater's latest reported attempt. */
export function createAutoUpdateHealthProvider(options: AutoUpdateOptions = {}) {
  const scope = options.scope ?? forGym, settings = options.settings ?? createAutoUpdateSettings({ scope });
  return healthProvider('automatic_updates', async (context) => {
    const checkedAt = context.clock.now().toISOString();
    if ((options.tenancy ?? tenancyMode()) === 'multi')
      return { id: 'automatic_updates', status: 'not_configured', checkedAt, details: null, message: message('tile.multi') };
    const [setting, attempt] = await Promise.all([settings.get(context.gymId),
      createAutoUpdateAttempts({ scope, clock: context.clock }).latest(context.gymId)]);
    const details: AutomaticUpdatesHealthDetails = automaticUpdatesHealthDetailsSchema.parse({ enabled: setting.enabled,
      lastAttemptAt: attempt?.attemptedAt ?? null, result: attempt?.result ?? 'never_run',
      fromVersion: attempt?.fromVersion ?? null, toVersion: attempt?.toVersion ?? null });
    return { id: 'automatic_updates', checkedAt, details, ...describeAttempt(setting.enabled, attempt, context.clock.now()) };
  });
}
