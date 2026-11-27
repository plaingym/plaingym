// SPDX-License-Identifier: AGPL-3.0-only
import { stat, statfs } from 'node:fs/promises';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { runningVersion } from './version.js';
import { auditEvents, forGym, smsDailyUsage } from '@plaingym/db';
import { localDate } from '@plaingym/shared/time';
import { sharedDiskVolume } from '@plaingym/shared/contracts';
import { PostgresJobStatsQuery } from '../../infra/jobs/postgres.js';
import type { JobStatsQuery } from '../../core/interfaces/job-stats.js';
import { sourceUrl } from '../../core/source-link.js';
import { restoreStagingDirectory } from '../../core/maintenance-credentials.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { tenancyMode } from '../../core/tenancy.js';
import { createSmtpResolver, installSmtpFingerprint } from '../settings/smtp.js';
import { readEmailSendFailure } from '../settings/email-status.js';
import { createSmsResolver } from '../settings/sms.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createGoogleClientResolver } from '../settings/google-login.js';
import { healthProvider, statusMessage } from './status.js';
import { createBackupHealthProvider } from './status-backups.js';
import { createUpdateAvailableProvider } from './updates.js';
import { countExhaustedEffects } from '../billing/transitions/effects.js';

export interface StatusOptions {
  env?: NodeJS.ProcessEnv;
  scope?: typeof forGym;
  jobs?: JobStatsQuery;
  disk?: (path: string) => Promise<{ blocks: number; bsize: number; bavail: number }>;
  /** The device a configured directory lives on, to tell whether two paths are one filesystem. */
  device?: (path: string) => Promise<number | bigint>;
}
/** Audit rows for submitted SMTP tests, plus legacy saves and removal. */
/** Decimal GB to two places, with more digits below 0.01 GB so a nearly full disk never reads "0 GB". */
const gigabytes = (bytes: number) => (bytes / 1_000_000_000)
  .toLocaleString('en', { maximumFractionDigits: 2, maximumSignificantDigits: 2, roundingPriority: 'morePrecision' });
const emailTestActions = ['integrations.email_saved', 'integrations.email_removed', 'setup.step_completed', 'integrations.email_tested', 'setup.email_tested'];
/**
 * The latest submitted SMTP test and its outcome, while the gym's own settings are in use (legacy saves too);
 * an explicit skip never counts. Removing the settings clears earlier tests, and install SMTP isn't tested here.
 */
function latestEmailTest(rows: readonly { action: string; after: unknown; occurredAt: Date }[], ownSettings: boolean): { at: string; failed: boolean } | null {
  for (const row of rows) {
    const after = row.after as { step?: unknown; test?: unknown } | null;
    if ((row.action === 'integrations.email_tested' || row.action === 'setup.email_tested') && (after?.test === 'sent' || after?.test === 'failed'))
      return ownSettings ? { at: row.occurredAt.toISOString(), failed: after.test === 'failed' } : null;
    if (row.action === 'integrations.email_removed') return null;
    if (row.action === 'integrations.email_saved' || (row.action === 'setup.step_completed' && after?.step === 5 && after.test !== 'not_sent'))
      return ownSettings ? { at: row.occurredAt.toISOString(), failed: false } : null;
  }
  return null;
}
export function createStatusProviders(options: StatusOptions = {}) {
  const env = options.env ?? process.env, scope = options.scope ?? forGym;
  const jobs = options.jobs ?? new PostgresJobStatsQuery(), disk = options.disk ?? statfs;
  const device = options.device ?? ((path: string) => stat(path, { bigint: true }).then((stats) => stats.dev));
  let key: Buffer | undefined;
  const encryptionKey = () => key ??= parseEncryptionKey(env.APP_ENCRYPTION_KEY ?? '');
  let smtp: ReturnType<typeof createSmtpResolver> | undefined, installSettings: string | null = null;
  let sms: ReturnType<typeof createSmsResolver> | undefined;
  const settings = createGymSettingsAccessor({ scope });
  return [createBackupHealthProvider({ env }), createUpdateAvailableProvider({ env }),
    healthProvider('invoice_effects', async context => {
      const exhausted = await countExhaustedEffects(context.gymId, scope);
      return { id: 'invoice_effects', status: exhausted ? 'error' : 'healthy', checkedAt: context.clock.now().toISOString(),
        message: statusMessage(exhausted ? 'effectsExhausted' : 'effectsHealthy', { exhausted }), details: { exhausted } };
    }),
    healthProvider('failed_jobs', async (context) => {
      const stats = await jobs.get(context.gymId);
      return { id: 'failed_jobs', status: stats.failed ? 'error' : 'healthy', checkedAt: context.clock.now().toISOString(),
        message: statusMessage(stats.failed ? 'jobsFailed' : 'jobsHealthy', { failed: stats.failed }),
        details: { failed: stats.failed, pending: stats.pending, running: stats.running, oldestFailureAt: stats.oldestFailureAt,
          failedVersion: stats.failedVersion } };
    }),
    healthProvider('smtp', async (context) => {
      if (env.DEMO_MODE === 'true') return { id: 'smtp', status: 'healthy', checkedAt: context.clock.now().toISOString(),
        details: { configured: true, lastTestAt: null }, message: statusMessage('smtpDemo') };
      if (!smtp) installSettings = installSmtpFingerprint(encryptionKey(), env);
      const resolver = smtp ??= createSmtpResolver({ key: encryptionKey(), env, scope });
      const { source, unreadable } = await resolver.status(context.gymId);
      const configured = source !== null;
      // The wizard writes a handful of step rows; the latest email row is among the newest of these few actions.
      const { rows, sendFailure } = await scope(context.gymId, async (tx) => ({
        rows: await tx.select({ action: auditEvents.action, after: auditEvents.after, occurredAt: auditEvents.occurredAt })
          .from(auditEvents).where(inArray(auditEvents.action, emailTestActions)).orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(50),
        // The last real send's failure, until a send works or the settings change (`settings/email-status.ts`).
        sendFailure: await readEmailSendFailure(tx, context.gymId, { installSettings }),
      }));
      const test = latestEmailTest(rows, source === 'gym');
      // A refused login through the install's `SMTP_*` settings is fixed on the server (single-gym) or by whoever runs the install.
      // The wording follows the settings the failure went through, not the ones in use now.
      const failureKey = sendFailure && (sendFailure.source === 'install' && sendFailure.failure === 'authentication'
        ? 'smtpLastFailed.authentication_' + (tenancyMode(env.TENANCY ?? 'single') === 'single' ? 'install' : 'operator')
        : 'smtpLastFailed.' + sendFailure.failure);
      // With no settings in use and none unreadable, nothing can send, so an old failure or test doesn't make it a warning.
      const status = !configured && !unreadable ? 'not_configured' : unreadable || test?.failed || sendFailure ? 'warning' : 'healthy';
      return { id: 'smtp', status, checkedAt: context.clock.now().toISOString(),
        details: { configured, lastTestAt: test?.at ?? null },
        message: [
          configured ? statusMessage(source === 'gym' ? 'smtpGym' : 'smtpInstall') : !unreadable && statusMessage('smtpMissing'),
          unreadable && statusMessage('smtpUnreadable'),
          test?.failed && statusMessage('smtpTestFailed'),
          configured && failureKey && statusMessage(failureKey),
        ].filter(Boolean).join(' ') };
    }),
    healthProvider('sms', async context => {
      const gym = await settings.get(context.gymId), now = context.clock.now();
      const resolver = sms ??= createSmsResolver({ key: env.DEMO_MODE === 'true' ? Buffer.alloc(32) : encryptionKey(),
        tenancy: env.TENANCY === 'multi' ? 'multi' : 'single', demo: env.DEMO_MODE === 'true', scope });
      const { source, unreadable } = await resolver.status(context.gymId), configured = source !== null;
      const { usage, test } = await scope(context.gymId, async tx => {
        const [usage] = await tx.select({ sent: smsDailyUsage.sent, refused: smsDailyUsage.refused }).from(smsDailyUsage)
          .where(and(eq(smsDailyUsage.gymId, context.gymId), eq(smsDailyUsage.day, localDate(now, gym.timezone))));
        const rows = await tx.select({ action: auditEvents.action, after: auditEvents.after, occurredAt: auditEvents.occurredAt }).from(auditEvents)
          .where(inArray(auditEvents.action, ['integrations.sms_tested', 'integrations.sms_removed']))
          .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(1);
        const row = rows[0], after = row?.after as { test?: unknown } | null;
        const test: { at: string; result: 'sent' | 'failed' } | null = source === 'demo' || row?.action !== 'integrations.sms_tested' || (after?.test !== 'sent' && after?.test !== 'failed')
          ? null : { at: row.occurredAt.toISOString(), result: after.test };
        return { usage, test };
      });
      const refused = usage?.refused ?? 0;
      const warning = unreadable || refused > 0 || test?.result === 'failed' || (gym.memberSmsEnabled && !configured);
      return { id: 'sms', status: warning ? 'warning' : !configured ? 'not_configured' : gym.memberSmsEnabled ? 'healthy' : 'warning',
        checkedAt: now.toISOString(), details: { configured, memberSmsEnabled: gym.memberSmsEnabled,
          sentToday: usage?.sent ?? 0, refusedToday: refused, smsDailyCap: gym.smsDailyCap,
          lastTestAt: test?.at ?? null, lastTestResult: test?.result ?? null },
        message: [
          configured ? statusMessage(source === 'demo' ? 'smsDemo' : 'smsConfigured') : !unreadable && statusMessage('smsMissing'),
          gym.memberSmsEnabled && !configured && statusMessage('smsOnWithoutProvider'),
          configured && !unreadable && !gym.memberSmsEnabled && statusMessage('smsOff'),
          unreadable && statusMessage('smsUnreadable'),
          refused > 0 && statusMessage('smsCapReached'),
          test?.result === 'failed' && statusMessage('smsTestFailed'),
        ].filter(Boolean).join(' ') };
    }),
    // A malformed GOOGLE_* variable no longer stops the app: this tile says which one and why, until it is fixed.
    healthProvider('google_login', async (context) => {
      const tenancy = (env.TENANCY ?? 'single') === 'multi' ? 'multi' : 'single';
      const resolver = createGoogleClientResolver({ key: encryptionKey(), env, tenancy, scope });
      const checkedAt = context.clock.now().toISOString();
      const configured = await resolver.credentials(context.gymId) !== null;
      if (resolver.problem && tenancy === 'single') return { id: 'google_login', status: configured ? 'warning' : 'error', checkedAt,
        details: configured ? { configured } : null, message: (configured ? statusMessage('googleGym') + ' ' : '')
          + statusMessage('googleProblem.' + resolver.problem.reason, { variable: resolver.problem.variable }) };
      return { id: 'google_login', status: configured ? 'healthy' : 'not_configured', checkedAt, details: { configured },
        message: statusMessage(configured ? resolver.install ? 'googleInstall' : 'googleGym' : 'googleMissing') };
    }),
    healthProvider('disk', async (context) => {
      // A multi-gym install's volumes are the operator's, shared by every gym, so no gym is shown their size or free space.
      if (tenancyMode(env.TENANCY ?? 'single') === 'multi') {
        return { id: 'disk', status: 'not_configured', checkedAt: context.clock.now().toISOString(), details: null, message: statusMessage('diskOperator') };
      }
      const paths = [env.UPLOADS_DIR, restoreStagingDirectory(env)].filter((path): path is string => !!path);
      if (!env.UPLOADS_DIR) return { id: 'disk', status: 'not_configured', checkedAt: context.clock.now().toISOString(), details: null, message: statusMessage('diskMissing') };
      const readVolumes = () => Promise.all(paths.map(async (path) => {
        const stats = await disk(path);
        const totalBytes = stats.blocks * stats.bsize, availableBytes = stats.bavail * stats.bsize;
        if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes) || totalBytes <= 0 || availableBytes < 0 || availableBytes > totalBytes) throw new Error('Invalid disk statistics');
        return { totalBytes, availableBytes };
      }));
      const [initialVolumes, devices] = await Promise.all([readVolumes(), Promise.all(paths.map(async (path) => device(path)))]);
      let volumes = initialVolumes;
      const critical = (bytes: number) => bytes < 128 * 1024 * 1024;
      const low = (volume: typeof volumes[number]) => volume.availableBytes / volume.totalBytes < 0.1 || volume.availableBytes < 1024 * 1024 * 1024;
      // ZFS and btrfs can report slightly different totals for the same volume. Cap the 0.1% tolerance at 64 MiB
      // so a staging quota on a large device can still have its own rows.
      const totalsMatch = ([uploads, staging]: typeof volumes) =>
        !!uploads && !!staging && Math.abs(uploads.totalBytes - staging.totalBytes)
          <= Math.min(Math.max(uploads.totalBytes, staging.totalBytes) / 1000, 64 * 1024 * 1024);
      const sameDevice = devices.length > 1 && BigInt(devices[0]!) === BigInt(devices[1]!);
      if (sameDevice && !totalsMatch(volumes)) volumes = await readVolumes();
      const sameFilesystem = sameDevice && totalsMatch(volumes);
      const uploads = volumes[0]!, staging = volumes[1];
      // Keep each volume's capacity and free space together, even when both directories share a filesystem.
      const details = { uploads, backupStaging: staging ?? null, sameFilesystem };
      // A shared volume reports the lower free figure and uses uploads on ties; the health page picks it the same way.
      const shared = sharedDiskVolume(details);
      return { id: 'disk', checkedAt: context.clock.now().toISOString(), details,
        status: volumes.some((v) => critical(v.availableBytes)) ? 'error' : volumes.some(low) ? 'warning' : 'healthy',
        message: statusMessage(sameFilesystem ? 'diskFreeShared' : staging ? 'diskFree' : 'diskFreeUploads', {
          uploads: gigabytes(shared.availableBytes), staging: gigabytes(staging?.availableBytes ?? 0),
        }) };
    }),
    healthProvider('version', async (context) => {
      const { version, commit } = runningVersion(env);
      if (!version.trim()) throw new Error('Missing version');
      return { id: 'version', status: 'healthy', checkedAt: context.clock.now().toISOString(),
        details: { version, sourceUrl: sourceUrl(env.SOURCE_URL) }, message: statusMessage('versionRunning', { version: `${version} (${commit.slice(0, 7)})` }) };
    }),
  ];
}
