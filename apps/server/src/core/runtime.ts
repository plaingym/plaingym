// SPDX-License-Identifier: AGPL-3.0-only
import { dirname } from 'node:path';
import type { Context } from 'hono';
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { AppError, createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { createApp } from './app.js';
import { clock } from './clock.js';
import type { RequestEnvironment } from './context.js';
import { registerModuleJobs } from './modules.js';
import { clientIp } from './rate-limit.js';
import { areaContributions } from './registry-areas.js';
import { createServerRegistry } from './registry.js';
import { parseEncryptionKey } from './secrets.js';
import { createTenantResolver, defaultHostname, listGyms, normalizeHostname, singleGymId, tenancyMode } from './tenancy.js';
import { authConfig, passwordLogin } from '../infra/auth/config.js';
import { createAuthService } from '../infra/auth/service.js';
import { createAuthEmailSender } from '../infra/auth/delivery.js';
import { sessionMiddleware } from '../infra/auth/middleware.js';
import { SmtpEmail } from '../infra/email/index.js';
import { PostgresJobs, startJobsWorker } from '../infra/jobs/postgres.js';
import { authorize } from '../areas/staff/auth.permissions.js';
import { configureLoginMethods } from '../areas/staff/auth.bootstrap.js';
import { createGymSettingsAccessor, createSettingsService } from '../areas/settings/settings.js';
import { createSmtpResolver } from '../areas/settings/smtp.js';
import { configureSignedLinkDelivery } from '../areas/links/service.js';
import { registerBackupJobs } from '../areas/health/backups.jobs.js';
import { PostgresMaintenance } from '../areas/health/backups.database.js';
import { configuredBackup, loadBackupConfig } from '../areas/health/restore.config.js';
import { RestoreGate } from '../areas/health/restore.gate.js';
import { configureAuthCli } from '../cli/auth.js';
import { runCli, type CommandIO } from '../cli/index.js';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
/** The install's public origin: `PUBLIC_ORIGIN`, else `https://` + `GYM_HOSTNAME` (as Caddy serves it). */
export function publicOrigin(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.PUBLIC_ORIGIN ?? (env.GYM_HOSTNAME ? `https://${env.GYM_HOSTNAME}` : undefined);
  if (!value) return undefined;
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.username) throw new Error('Invalid PUBLIC_ORIGIN');
  return url.origin;
}

/** Shared setup for the server and the database-backed CLI commands. */
async function prepare(env: NodeJS.ProcessEnv) {
  const key = parseEncryptionKey(required(env, 'APP_ENCRYPTION_KEY'));
  const mode = tenancyMode(env.TENANCY ?? 'single');
  const config = authConfig(env);
  const install = publicOrigin(env);
  if (mode === 'single' && !install) throw new Error('Set GYM_HOSTNAME or PUBLIC_ORIGIN');
  await initializeDatabase(required(env, 'DATABASE_URL'));
  const smtp = createSmtpResolver({ key, env });
  configureAuthCli({ resolveGymId: () => singleGymId(), smtpConfigured: (gymId) => smtp.configured(gymId) });
  return { key, mode, config, install, smtp };
}

export interface Runtime {
  readonly app: ReturnType<typeof createApp>;
  stop(): Promise<void>;
}
export async function startRuntime(env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  const { key, mode, config, install, smtp } = await prepare(env);
  // Caddy is the only peer that can reach the app in the Compose deployment.
  const trustedProxy = env.TRUST_PROXY === 'true' ? () => true : undefined;
  const originFor = (context: Context<RequestEnvironment>): string => {
    if (mode === 'single') return install!;
    // In multi mode the tenant resolver has already matched this hostname to the gym.
    const hostname = normalizeHostname(context.req.header('host') ?? '');
    if (!hostname) throw new AppError('not_found', 'Gym not found');
    return `https://${hostname}`;
  };
  async function gymOrigin(gymId: string): Promise<string> {
    if (mode === 'single') return install!;
    const hostname = await defaultHostname(gymId);
    if (!hostname) throw new AppError('unavailable', 'The gym has no default hostname');
    return `https://${hostname}`;
  }

  const auth = createAuthService({ config, sendMagicLink: createAuthEmailSender((gymId) => smtp.config(gymId)) });
  configureLoginMethods(async (gymId) => {
    const configured = await smtp.configured(gymId);
    return { password: passwordLogin(config, configured), magicLink: configured };
  });
  const settings = createSettingsService(), t = createTranslator(locales.en ?? {});
  configureSignedLinkDelivery({ async prepare(gymId) {
    const [details, origin, mail] = await Promise.all([settings.get(gymId), gymOrigin(gymId), smtp.config(gymId)]);
    if (!mail) throw new AppError('unavailable', 'Email is not configured for this gym');
    return { gymId, gymName: details.name, origin, email: new SmtpEmail(mail), memberEmailsEnabled: details.memberEmailsEnabled, t };
  } });

  // Restore state and activity leases live beside the staging directory, as in the maintenance CLI.
  const gate = env.BACKUP_STAGING_DIR ? new RestoreGate(dirname(env.BACKUP_STAGING_DIR)) : undefined;
  const app = createApp({
    contributions: areaContributions, clock, resolveGym: createTenantResolver({ mode }), authorize,
    session: sessionMiddleware({ auth, smtpConfigured: (gymId) => smtp.configured(gymId), resolve: (context) => {
      const address = clientIp(context, { ...(trustedProxy ? { trustedProxy } : {}) });
      return { gymId: context.get('context').gym.gymId, origin: originFor(context), clientIp: address === 'unknown' ? '0.0.0.0' : address };
    } }),
    origin: originFor, ...(install ? { installOrigin: install } : {}),
    ...(trustedProxy ? { rateLimit: { trustedProxy } } : {}), ...(gate ? { restoreGate: gate.middleware() } : {}),
    ...(env.SOURCE_URL ? { sourceUrl: env.SOURCE_URL } : {}),
  });

  const queue = new PostgresJobs({ clock, listGyms: () => listGyms() });
  registerModuleJobs(createServerRegistry(areaContributions), queue, createGymSettingsAccessor());
  const report = (error: unknown) => console.error('Background job error', error);
  let backupTimer: NodeJS.Timeout | undefined;
  if (gate && env.MAINTENANCE_DATABASE_URL && env.UPLOADS_DIR) {
    const database = new PostgresMaintenance(env.MAINTENANCE_DATABASE_URL);
    const staging = env.BACKUP_STAGING_DIR!, uploads = env.UPLOADS_DIR;
    // Backups exist only after the owner configures them in setup, so the service is built per run.
    const backups = registerBackupJobs(queue, { async snapshot(kind) {
      const backup = configuredBackup(await loadBackupConfig(key), database, clock, staging, uploads);
      try { return await backup.service.snapshot(kind); } finally { backup.client.destroy(); }
    } }, clock, () => gate.isClosed());
    const schedule = async () => {
      try { await loadBackupConfig(key); } catch { return; }
      await backups.scheduleDue();
    };
    // Snapshots are hourly; checking each minute keeps scheduling off the worker's poll path.
    backupTimer = setInterval(() => { schedule().catch(report); }, 60_000);
    backupTimer.unref();
    schedule().catch(report);
  }
  const worker = startJobsWorker(queue, { onError: report,
    ...(gate ? { paused: () => gate.isClosed(), around: (execute: () => Promise<void>) => gate.activity(execute) } : {}) });

  return { app, async stop() {
    if (backupTimer) clearInterval(backupTimer);
    try { await worker.stop(); } finally { await closeDatabase(); }
  } };
}

/** `gym-app <command>`: the restore command manages its own connections; the others use the app database. */
export async function runCommandLine(args: readonly string[], io: CommandIO, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (args[0] === 'restore') return runCli(args, io);
  try { await prepare(env); }
  catch (error) { io.stderr(error instanceof Error ? error.message : 'Startup failed'); return 1; }
  try { return await runCli(args, io); } finally { await closeDatabase(); }
}
