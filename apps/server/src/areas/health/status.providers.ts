// SPDX-License-Identifier: AGPL-3.0-only
import { statfs } from 'node:fs/promises';
import release from '../../../../../package.json' with { type: 'json' };
import { forGym } from '@plaingym/db';
import { PostgresJobStatsQuery } from '../../infra/jobs/postgres.js';
import type { JobStatsQuery } from '../../core/interfaces/job-stats.js';
import { sourceUrl } from '../../core/source-link.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { createSmtpResolver } from '../settings/smtp.js';
import { healthProvider, statusMessage } from './status.js';
import { createBackupHealthProvider } from './status-backups.js';

export interface StatusOptions {
  env?: NodeJS.ProcessEnv;
  scope?: typeof forGym;
  jobs?: JobStatsQuery;
  disk?: (path: string) => Promise<{ blocks: number; bsize: number; bavail: number }>;
}
export function createStatusProviders(options: StatusOptions = {}) {
  const env = options.env ?? process.env, scope = options.scope ?? forGym;
  const jobs = options.jobs ?? new PostgresJobStatsQuery(), disk = options.disk ?? statfs;
  return [createBackupHealthProvider({ env }),
    healthProvider('failed_jobs', async (context) => {
      const stats = await jobs.get(context.gymId);
      return { id: 'failed_jobs', status: stats.failed ? 'error' : 'healthy', checkedAt: context.clock.now().toISOString(),
        message: statusMessage(stats.failed ? 'jobsFailed' : 'jobsHealthy', { failed: stats.failed }),
        // TODO(CCR): JobStatsQuery exposes oldestPendingAt, but no oldestFailureAt. Never substitute pending time.
        details: { failed: stats.failed, pending: stats.pending, running: stats.running, oldestFailureAt: null } };
    }),
    healthProvider('smtp', async (context) => {
      let own = false;
      // TODO(CCR): expose source on SmtpResolver. Its scoped query returns the stored encrypted setting;
      // observe only presence here, without importing system tables or returning credentials.
      const resolver = createSmtpResolver({ key: parseEncryptionKey(env.APP_ENCRYPTION_KEY ?? ''), env,
        scope: async (gymId, query) => { const stored = await scope(gymId, query); own = Boolean(stored); return stored; } });
      const configured = await resolver.configured(context.gymId);
      return { id: 'smtp', status: configured ? 'healthy' : 'not_configured', checkedAt: context.clock.now().toISOString(),
        details: { configured, lastTestAt: null }, message: statusMessage(configured ? own ? 'smtpGym' : 'smtpInstall' : 'smtpMissing') };
    }),
    healthProvider('disk', async (context) => {
      if (!env.UPLOADS_DIR || !env.BACKUP_STAGING_DIR) return { id: 'disk', status: 'not_configured', checkedAt: context.clock.now().toISOString(), details: null, message: statusMessage('diskMissing') };
      const volumes = await Promise.all([env.UPLOADS_DIR, env.BACKUP_STAGING_DIR].map(async (path) => {
        const stats = await disk(path), totalBytes = stats.blocks * stats.bsize, availableBytes = stats.bavail * stats.bsize;
        if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes) || totalBytes <= 0 || availableBytes < 0 || availableBytes > totalBytes) throw new Error('Invalid disk statistics');
        return { totalBytes, availableBytes };
      }));
      const critical = (bytes: number) => bytes < 128 * 1024 * 1024;
      const low = (volume: typeof volumes[number]) => volume.availableBytes / volume.totalBytes < 0.1 || volume.availableBytes < 1024 * 1024 * 1024;
      // TODO(CCR): the contract has one volume. Details carry the volume with least available space;
      // the message includes both configured directories, without exposing filesystem paths.
      const details = [...volumes].sort((a, b) => a.availableBytes - b.availableBytes)[0]!;
      return { id: 'disk', checkedAt: context.clock.now().toISOString(), details,
        status: volumes.some((v) => critical(v.availableBytes)) ? 'error' : volumes.some(low) ? 'warning' : 'healthy',
        message: statusMessage('diskFree', { uploads: Math.floor(volumes[0]!.availableBytes / 1048576), staging: Math.floor(volumes[1]!.availableBytes / 1048576) }) };
    }),
    healthProvider('version', async (context) => {
      const version = env.APP_VERSION ?? release.version;
      if (!version.trim()) throw new Error('Missing version');
      return { id: 'version', status: 'healthy', checkedAt: context.clock.now().toISOString(),
        details: { version, sourceUrl: sourceUrl(env.SOURCE_URL) }, message: statusMessage('versionRunning', { version }) };
    }),
  ];
}
