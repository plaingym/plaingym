// SPDX-License-Identifier: AGPL-3.0-only
import { dirname } from 'node:path';
import type { Context } from 'hono';
import { connectionBudget, initializeDatabase, closeDatabase } from '@plaingym/db/client';
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
import { createGymKeyResolver } from '../areas/settings/gym-keys.js';
import { configureMembers } from '../areas/members/members.routes.js';
import { createMembersService } from '../areas/members/members.js';
import { configureStaffProfiles } from '../areas/staff/profiles.routes.js';
import { createStaffInvitationService, smtpMailer } from '../areas/staff/profiles.invitations.js';
import { configureDashboard } from '../areas/dashboard/dashboard.routes.js';
import { configureImportStep } from '../areas/setup/import-step.js';
import { configureGoLive } from '../areas/settings/go-live.js';
import { createRanksService } from '../areas/ranks/ranks.service.js';
import { configureKiosk } from '../areas/kiosk/standing/standing.routes.js';
import { createMemberPhotoJobs } from '../areas/members/members.jobs.js';
import { createSmtpResolver } from '../areas/settings/smtp.js';
import { configureSignedLinkDelivery } from '../areas/links/service.js';
import { registerBackupJobs } from '../areas/health/backups.jobs.js';
import { PostgresMaintenance } from '../areas/health/backups.database.js';
import { backupsConfigured, configuredBackup, loadBackupConfig } from '../areas/health/restore.config.js';
import { createUploadSweepJobs } from '../areas/health/uploads-sweep.js';
import { RestoreGate } from '../areas/health/restore.gate.js';
import { configureAuthCli } from '../cli/auth.js';
import { runCli, type CommandIO } from '../cli/index.js';
import { demoBootCheck } from '../demo/config.js';
import { createDemoRuntime } from '../demo/runtime.js';
import { createRuntimeUploads } from '../infra/storage/runtime.js';
import { createUploadDownloadRoute } from './uploads-download.js';
import { logError } from './log.js';
import { createKioskAuthMiddleware } from '../areas/kiosk/devices.auth.js';
import { configureHealthStatus } from '../areas/health/status.routes.js';
import { createSetupLinkCommand } from '../cli/setup-link.js';
import { configureRanks } from '../areas/ranks/ranks.routes.js';
import { createAttendanceQueries } from '../areas/attendance/attendance.js';
import { createImportPipeline } from '../areas/imports/pipeline.js';
import { createPipelineRoutes } from '../areas/imports/pipeline.routes.js';
import { createPipelineJobs } from '../areas/imports/pipeline.jobs.js';
import { createExportService } from '../areas/imports/export.js';
import { createExportRoutes } from '../areas/imports/export.routes.js';
import { createExportJobs } from '../areas/imports/export.jobs.js';

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

/** The app pool size: `DATABASE_POOL_MAX`, else the budgeted default that fits the shipped Postgres. */
export function poolSize(env: NodeJS.ProcessEnv): number {
  if (env.DATABASE_POOL_MAX === undefined) return connectionBudget.application;
  const value = Number(env.DATABASE_POOL_MAX);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error('DATABASE_POOL_MAX must be an integer from 1 to 100');
  return value;
}
/** Shared setup for the server and the database-backed CLI commands. */
async function prepare(env: NodeJS.ProcessEnv) {
  const demo = demoBootCheck(env);
  const key = parseEncryptionKey(required(env, 'APP_ENCRYPTION_KEY'));
  const mode = tenancyMode(env.TENANCY ?? 'single');
  const config = demo.enabled ? authConfig({ ...env, AUTH_PASSWORD_LOGIN: 'off' }, true) : authConfig(env);
  const install = publicOrigin(env) ?? (demo.enabled ? `https://${demo.domain}` : undefined);
  if (mode === 'single' && !install) throw new Error('Set GYM_HOSTNAME or PUBLIC_ORIGIN');
  await initializeDatabase(required(env, 'DATABASE_URL'), poolSize(env));
  const smtp = demo.enabled ? undefined : createSmtpResolver({ key, env });
  configureAuthCli({ resolveGymId: () => singleGymId(), smtpConfigured: (gymId) => smtp ? smtp.configured(gymId) : Promise.resolve(true) });
  return { key, mode, config, install, smtp };
}

export interface Runtime {
  readonly app: ReturnType<typeof createApp>;
  readonly uploadsFor: ReturnType<typeof createRuntimeUploads>['forGym'];
  stop(): Promise<void>;
}
export async function startRuntime(env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  const { key, mode, config: initialConfig, install, smtp } = await prepare(env);
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

  const uploads = createRuntimeUploads(env, key, gymOrigin);
  const demo = await createDemoRuntime({ env, installOrigin: install ?? '', removeUploads: uploads.removeGym,
    ...(trustedProxy ? { clientIp: { trustedProxy } } : {}) });
  const config = demo?.authConfig ?? initialConfig;
  const smtpConfigured = (gymId: string) => demo ? Promise.resolve(true) : smtp!.configured(gymId);
  const auth = createAuthService({ config, sendMagicLink: demo?.sendMagicLink ?? createAuthEmailSender((gymId) => smtp!.config(gymId)) });
  configureLoginMethods(async (gymId) => {
    const configured = await smtpConfigured(gymId);
    return { password: passwordLogin(config, configured), magicLink: configured };
  });
  const settings = createSettingsService(), t = createTranslator(locales.en ?? {});
  configureSignedLinkDelivery({ async prepare(gymId) {
    const [details, origin, mail] = await Promise.all([settings.get(gymId), gymOrigin(gymId), demo ? Promise.resolve(null) : smtp!.config(gymId)]);
    if (!demo && !mail) throw new AppError('unavailable', 'Email is not configured for this gym');
    return { gymId, gymName: details.name, origin, email: demo ? demo.emailFor(gymId) : new SmtpEmail(mail!), memberEmailsEnabled: details.memberEmailsEnabled, t };
  } });

  // Restore state and activity leases live beside the staging directory, as in the maintenance CLI.
  const gate = env.BACKUP_STAGING_DIR ? new RestoreGate(dirname(env.BACKUP_STAGING_DIR)) : undefined;
  configureHealthStatus({ env });
  const queue = new PostgresJobs({ clock, listGyms: () => listGyms() });
  // Ranks read attendance through the frozen interface; imports and exports need storage and the queue.
  const attendance = createAttendanceQueries({ clock });
  const criteria = configureRanks({ attendance, clock });
  // The dashboard reads through the same services, with the ranks criteria registry and clock.
  configureDashboard({ members: createMembersService({ clock }), ranks: createRanksService({ clock, criteria }), attendance });
  // Staff invitations use the gym's SMTP (or the demo outbox); photos use the gym's file storage.
  configureStaffProfiles({ invitations: createStaffInvitationService({ config, smtpConfigured,
    mailer: demo ? demo.emailFor : smtpMailer(smtp!) }), uploadsFor: uploads.forGym, origin: originFor });
  configureGoLive({ clock, smtpConfigured });
  // Household PINs use the gym's random key; member photos use the gym's file storage.
  const gymKey = createGymKeyResolver({ key });
  configureMembers({ pinSecret: gymKey, uploadsFor: uploads.forGym, clock });
  configureKiosk({ pinSecret: gymKey, uploadsFor: uploads.forGym, clock });
  const importPipeline = createImportPipeline({ uploadsFor: uploads.forGym, jobs: queue, clock });
  const exportService = createExportService({ uploadsFor: uploads.forGym, jobs: queue, clock });
  // Setup step 8 finishes with a committed run from this pipeline.
  configureImportStep({ imports: importPipeline, clock });
  const contributions = { ...areaContributions,
    routes: [...areaContributions.routes ?? [], ...createPipelineRoutes(importPipeline), ...createExportRoutes(exportService),
      createUploadDownloadRoute({ uploadsFor: uploads.forGym, origin: originFor })],
    jobs: [...areaContributions.jobs ?? [], ...createPipelineJobs(importPipeline), ...createExportJobs(exportService), ...createMemberPhotoJobs(uploads.forGym),
      ...createUploadSweepJobs({ uploadsFor: uploads.forGym, backupsConfigured: () => mode === 'multi' ? Promise.resolve(false) : backupsConfigured(key),
        ...(env.MAINTENANCE_DATABASE_URL ? { locked: (action) => new PostgresMaintenance(env.MAINTENANCE_DATABASE_URL!).locked(action) } : {}) })] };
  const app = createApp({
    contributions, clock, resolveGym: createTenantResolver({ mode }), authorize,
    session: createKioskAuthMiddleware({ ...(trustedProxy ? { trustedProxy } : {}), session: sessionMiddleware({ auth, smtpConfigured, resolve: (context) => {
      const address = clientIp(context, { ...(trustedProxy ? { trustedProxy } : {}) });
      return { gymId: context.get('context').gym.gymId, origin: originFor(context), clientIp: address === 'unknown' ? '0.0.0.0' : address };
    } }) }),
    origin: originFor, ...(install ? { installOrigin: install } : {}),
    ...(trustedProxy ? { rateLimit: { trustedProxy } } : {}), ...(gate ? { restoreGate: gate.middleware() } : {}),
    ...(env.SOURCE_URL ? { sourceUrl: env.SOURCE_URL } : {}),
    ...(env.SETUP_TOKEN ? { setupToken: env.SETUP_TOKEN } : {}), ...(demo ? { skipSetup: demo.skipSetup } : {}),
  });

  registerModuleJobs(createServerRegistry(contributions), queue, createGymSettingsAccessor());
  const report = (error: unknown) => logError('jobs.error', {}, error);
  const cleanup = demo?.registerCleanup(queue);
  let demoTimer: NodeJS.Timeout | undefined;
  if (cleanup) {
    const schedule = async () => {
      if (gate) { if (!await gate.isClosed()) await gate.activity(() => cleanup.scheduleDue()); }
      else await cleanup.scheduleDue();
    };
    demoTimer = setInterval(() => { schedule().catch(report); }, 60_000);
    demoTimer.unref();
    await schedule();
  }
  let backupTimer: NodeJS.Timeout | undefined;
  if (gate && env.MAINTENANCE_DATABASE_URL) {
    const database = new PostgresMaintenance(env.MAINTENANCE_DATABASE_URL);
    const staging = env.BACKUP_STAGING_DIR!;
    // Backups exist only after the owner configures them in setup, so the service is built per run.
    const backups = registerBackupJobs(queue, { async snapshot(kind) {
      const backup = configuredBackup(await loadBackupConfig(key), database, clock, staging, uploads.forGym);
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

  return { app, uploadsFor: uploads.forGym, async stop() {
    if (backupTimer) clearInterval(backupTimer);
    if (demoTimer) clearInterval(demoTimer);
    try { await worker.stop(); } finally { uploads.close(); await closeDatabase(); }
  } };
}

/** `gym-app <command>`: the restore command manages its own connections; the others use the app database. */
export async function runCommandLine(args: readonly string[], io: CommandIO, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (args[0] === 'restore') return runCli(args, io);
  if (args[0] === 'setup-link') return createSetupLinkCommand(env).run(args.slice(1), io);
  // Migrating needs only the maintenance role, as in the container entrypoint.
  if (args[0] === 'migrate') return runCli(args, io);
  try { await prepare(env); }
  catch (error) { io.stderr(error instanceof Error ? error.message : 'Startup failed'); return 1; }
  try { return await runCli(args, io); } finally { await closeDatabase(); }
}
