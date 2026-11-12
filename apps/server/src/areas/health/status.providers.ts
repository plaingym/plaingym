// SPDX-License-Identifier: AGPL-3.0-only
import { statfs } from 'node:fs/promises';
import { desc, inArray } from 'drizzle-orm';
import { runningVersion } from './version.js';
import { auditEvents, forGym } from '@plaingym/db';
import { PostgresJobStatsQuery } from '../../infra/jobs/postgres.js';
import type { JobStatsQuery } from '../../core/interfaces/job-stats.js';
import { sourceUrl } from '../../core/source-link.js';
import { restoreStagingDirectory } from '../../core/maintenance-credentials.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { createSmtpResolver } from '../settings/smtp.js';
import { createGoogleClientResolver } from '../settings/google-login.js';
import { healthProvider, statusMessage } from './status.js';
import { createBackupHealthProvider } from './status-backups.js';
import { createUpdateAvailableProvider } from './updates.js';

export interface StatusOptions {
  env?: NodeJS.ProcessEnv;
  scope?: typeof forGym;
  jobs?: JobStatsQuery;
  disk?: (path: string) => Promise<{ blocks: number; bsize: number; bavail: number }>;
}
/** Audit rows for submitted SMTP tests, plus legacy saves and removal. */
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
export function lastEmailTest(rows: readonly { action: string; after: unknown; occurredAt: Date }[], ownSettings: boolean): string | null {
  return latestEmailTest(rows, ownSettings)?.at ?? null;
}
export function createStatusProviders(options: StatusOptions = {}) {
  const env = options.env ?? process.env, scope = options.scope ?? forGym;
  const jobs = options.jobs ?? new PostgresJobStatsQuery(), disk = options.disk ?? statfs;
  return [createBackupHealthProvider({ env }), createUpdateAvailableProvider({ env }),
    healthProvider('failed_jobs', async (context) => {
      const stats = await jobs.get(context.gymId);
      return { id: 'failed_jobs', status: stats.failed ? 'error' : 'healthy', checkedAt: context.clock.now().toISOString(),
        message: statusMessage(stats.failed ? 'jobsFailed' : 'jobsHealthy', { failed: stats.failed }),
        // TODO: add oldestFailureAt to JobStatsQuery. Never substitute oldestPendingAt.
        details: { failed: stats.failed, pending: stats.pending, running: stats.running, oldestFailureAt: null } };
    }),
    healthProvider('smtp', async (context) => {
      const resolver = createSmtpResolver({ key: parseEncryptionKey(env.APP_ENCRYPTION_KEY ?? ''), env, scope });
      const configured = await resolver.configured(context.gymId);
      const source = await resolver.source(context.gymId);
      // The wizard writes a handful of step rows; the latest email row is among the newest of these few actions.
      const rows = await scope(context.gymId, (tx) => tx.select({ action: auditEvents.action, after: auditEvents.after, occurredAt: auditEvents.occurredAt })
        .from(auditEvents).where(inArray(auditEvents.action, emailTestActions)).orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(50));
      const test = latestEmailTest(rows, source === 'gym');
      const message = statusMessage(configured ? source === 'gym' ? 'smtpGym' : 'smtpInstall' : 'smtpMissing');
      return { id: 'smtp', status: test?.failed ? 'warning' : configured ? 'healthy' : 'not_configured', checkedAt: context.clock.now().toISOString(),
        details: { configured, lastTestAt: test?.at ?? null }, message: test?.failed ? message + ' ' + statusMessage('smtpTestFailed') : message };
    }),
    // A malformed GOOGLE_* variable no longer stops the app: this tile says which one and why, until it is fixed.
    healthProvider('google_login', async (context) => {
      const tenancy = (env.TENANCY ?? 'single') === 'multi' ? 'multi' : 'single';
      const resolver = createGoogleClientResolver({ key: parseEncryptionKey(env.APP_ENCRYPTION_KEY ?? ''), env, tenancy, scope });
      const checkedAt = context.clock.now().toISOString();
      const configured = await resolver.credentials(context.gymId) !== null;
      if (resolver.problem && tenancy === 'single') return { id: 'google_login', status: configured ? 'warning' : 'error', checkedAt,
        details: configured ? { configured } : null, message: (configured ? statusMessage('googleGym') + ' ' : '')
          + statusMessage('googleProblem.' + resolver.problem.reason, { variable: resolver.problem.variable }) };
      return { id: 'google_login', status: configured ? 'healthy' : 'not_configured', checkedAt, details: { configured },
        message: statusMessage(configured ? resolver.install ? 'googleInstall' : 'googleGym' : 'googleMissing') };
    }),
    healthProvider('disk', async (context) => {
      // Multi-gym apps hold no restore staging (even if the variable is set by hand), so there the uploads volume alone is checked.
      const paths = [env.UPLOADS_DIR, restoreStagingDirectory(env)].filter((path): path is string => !!path);
      if (!env.UPLOADS_DIR) return { id: 'disk', status: 'not_configured', checkedAt: context.clock.now().toISOString(), details: null, message: statusMessage('diskMissing') };
      const volumes = await Promise.all(paths.map(async (path) => {
        const stats = await disk(path), totalBytes = stats.blocks * stats.bsize, availableBytes = stats.bavail * stats.bsize;
        if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes) || totalBytes <= 0 || availableBytes < 0 || availableBytes > totalBytes) throw new Error('Invalid disk statistics');
        return { totalBytes, availableBytes };
      }));
      const critical = (bytes: number) => bytes < 128 * 1024 * 1024;
      const low = (volume: typeof volumes[number]) => volume.availableBytes / volume.totalBytes < 0.1 || volume.availableBytes < 1024 * 1024 * 1024;
      // TODO: expose separate volumes in the contract. Details carry the volume with least available space;
      // the message includes each configured directory, without exposing filesystem paths.
      const details = [...volumes].sort((a, b) => a.availableBytes - b.availableBytes)[0]!;
      return { id: 'disk', checkedAt: context.clock.now().toISOString(), details,
        status: volumes.some((v) => critical(v.availableBytes)) ? 'error' : volumes.some(low) ? 'warning' : 'healthy',
        message: statusMessage(volumes[1] ? 'diskFree' : 'diskFreeUploads', { uploads: Math.floor(volumes[0]!.availableBytes / 1048576), staging: volumes[1] ? Math.floor(volumes[1].availableBytes / 1048576) : 0 }) };
    }),
    healthProvider('version', async (context) => {
      const { version, commit } = runningVersion(env);
      if (!version.trim()) throw new Error('Missing version');
      return { id: 'version', status: 'healthy', checkedAt: context.clock.now().toISOString(),
        details: { version, sourceUrl: sourceUrl(env.SOURCE_URL) }, message: statusMessage('versionRunning', { version: `${version} (${commit.slice(0, 7)})` }) };
    }),
  ];
}
