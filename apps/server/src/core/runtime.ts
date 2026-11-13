// SPDX-License-Identifier: AGPL-3.0-only
import { dirname } from 'node:path';
import { hkdfSync } from 'node:crypto';
import type { Context } from 'hono';
import { connectionBudget, initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { AppError, createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { createApp } from './app.js';
import { clock } from './clock.js';
import type { RequestEnvironment } from './context.js';
import { assertMaintenanceCredentials, restoreStagingDirectory } from './maintenance-credentials.js';
import { registerModuleJobs } from './modules.js';
import { clientIp } from './rate-limit.js';
import { registerIntakeRateLimits } from './rate-limit-store.js';
import { areaContributions } from './registry-areas.js';
import { createServerRegistry, type ModuleDefinition } from './registry.js';
import { parseEncryptionKey } from './secrets.js';
import { createTenantResolver, defaultHostname, listGyms, normalizeHostname, reportHostnameSnapshot, singleGymId, tenancyMode } from './tenancy.js';
import { authConfig, passwordLogin } from '../infra/auth/config.js';
import { createAuthService } from '../infra/auth/service.js';
import { createGoogleAuthExtension, googleFromEnvironment } from '../infra/auth/google.js';
import { createAuthEmailSender } from '../infra/auth/delivery.js';
import { sessionMiddleware } from '../infra/auth/middleware.js';
import { createEmailDeliveryJobs, SmtpEmail } from '../infra/email/index.js';
import { PostgresJobs, startJobsWorker } from '../infra/jobs/postgres.js';
import { createPortalAuthorization } from '../areas/portal/auth.permissions.js';
import { configurePortalAccess } from '../areas/portal/access.routes.js';
import { createPortalPrincipalLoader } from '../areas/members/household-users.context.js';
import { createPortalInvitationExpiryJobs, createPortalInvitationService, registerVerificationSweep } from '../areas/members/household-users.invitations.js';
import { createPortalConfirmationWidgetProvider } from '../areas/members/household-users.widget.js';
import { configureLoginMethods } from '../areas/staff/auth.bootstrap.js';
import { createGymSettingsAccessor, createSettingsService } from '../areas/settings/settings.js';
import { createGymKeyResolver } from '../areas/settings/gym-keys.js';
import { createDropInFee } from '../areas/settings/drop-in-fee.js';
import { configureMembers } from '../areas/members/members.routes.js';
import { guardRedaction } from '../areas/members/erasure-redaction.js';
import { createMembersService } from '../areas/members/members.js';
import { configureStaffProfiles } from '../areas/staff/profiles.routes.js';
import { createStaffInvitationService, smtpMailer } from '../areas/staff/profiles.invitations.js';
import { configureDashboard } from '../areas/dashboard/dashboard.routes.js';
import { createNotSeenRead } from '../areas/dashboard/not-seen.js';
import { configureBillingDashboard } from '../areas/dashboard/billing.routes.js';
import { createSkippedCollectionsProvider } from '../areas/dashboard/billing.js';
import { createFollowUpsDueProvider } from '../areas/dashboard/leads.js';
import { configureImportStep } from '../areas/setup/import-step.js';
import { createSetupRoutes } from '../areas/setup/setup.routes.js';
import { configureGoLive } from '../areas/settings/go-live.js';
import { checkIntegrationsEnvironment, configureIntegrations } from '../areas/settings/integrations.js';
import { createRanksService } from '../areas/ranks/ranks.service.js';
import { configureCheckinCodes } from '../areas/members/checkin-code.routes.js';
import { createCheckinCodeService } from '../areas/members/checkin-code.js';
import { configureQrCheckin } from '../areas/kiosk/qr.routes.js';
import { configureKiosk } from '../areas/kiosk/standing/standing.routes.js';
import { configureWaivers } from '../areas/waivers/waivers.routes.js';
import { createWaiverDocumentDelivery } from '../areas/waivers/document-delivery.js';
import { documentByteLimit } from '../infra/pdf/document.js';
import { defaultBodyLimits } from './body-limit.js';
import { configureLinkPages } from '../public/links/links.routes.js';
import { configurePublicPages } from '../public/pages/pages.routes.js';
import { configureJoin } from '../public/pages/join.routes.js';
import { createPublicStaffNotices } from '../public/pages/notifications.js';
import { configurePublicStaffNotices } from '../public/pages/pages.jobs.js';
import { createBookingDelivery } from '../areas/bookings/bookings.delivery.js';
import { configureBookingJobs } from '../areas/bookings/bookings.jobs.js';
import { configureBookingRoutes } from '../areas/bookings/bookings.routes.js';
import { configurePortalBookingRoutes } from '../areas/portal/bookings.routes.js';
import { configurePortalCheckin } from '../areas/portal/checkin.routes.js';
import { configurePortalProgress } from '../areas/portal/progress.routes.js';
import { configurePortalBilling } from '../areas/portal/billing.routes.js';
import { configurePortalWaivers } from '../areas/portal/waivers.routes.js';
import { createSignedLinkCheckout } from '../areas/billing/signed-link-checkout.js';
import { createMemberPhotoJobs } from '../areas/members/members.jobs.js';
import { createSmtpResolver } from '../areas/settings/smtp.js';
import { configureSignedLinkDelivery } from '../areas/links/service.js';
import { configureCampaigns, createCampaignsService } from '../areas/links/campaigns.js';
import { configureCancellationNotice, createCancellationNotice } from '../areas/announcements/cancellation.js';
import { configureAnnouncements, createAnnouncementsService } from '../areas/announcements/send.js';
import { registerBackupJobs } from '../areas/health/backups.jobs.js';
import { PostgresMaintenance } from '../areas/health/backups.database.js';
import { backupsConfigured, configuredBackup, loadBackupConfig } from '../areas/health/restore.config.js';
import { createUploadSweepJobs } from '../areas/health/uploads-sweep.js';
import { RestoreGate } from '../areas/health/restore.gate.js';
import { configureAuthCli } from '../cli/auth.js';
import { runCli, type CommandIO } from '../cli/index.js';
import { demoBootCheck } from '../demo/config.js';
import { createDemoRuntime } from '../demo/runtime.js';
import type { DetachOptions } from '../infra/payments/index.js';
import { createDemoPayments } from '../demo/payments.js';
import { demoWebhookMiddleware } from '../demo/webhook.js';
import { createRuntimeUploads } from '../infra/storage/runtime.js';
import { createUploadDownloadRoute } from './uploads-download.js';
import { logError } from './log.js';
import { imageOrigins } from './csp.js';
import { createKioskAuthMiddleware } from '../areas/kiosk/devices.auth.js';
import { createPinLimitWidgetProvider } from '../areas/kiosk/pin-limit.js';
import { configureHealthStatus } from '../areas/health/status.routes.js';
import { configureUpdateRoutes } from '../areas/health/updates.routes.js';
import { createGoogleClientResolver } from '../areas/settings/google-login.js';
import { createStripeHealthProvider } from '../areas/health/stripe.js';
import { createChargeRunHealthProvider, monitorChargeRunner } from '../areas/health/charge-run.js';
import { createAutoUpdateHealthProvider } from '../areas/health/auto-update.js';
import { configureChargeFailures } from '../areas/health/charge-run.routes.js';
import { createSetupLinkCommand } from '../cli/setup-link.js';
import { configureRanks } from '../areas/ranks/ranks.routes.js';
import { createAttendanceQueries } from '../areas/attendance/attendance.js';
import { createImportPipeline } from '../areas/imports/pipeline.js';
import { createPipelineRoutes } from '../areas/imports/pipeline.routes.js';
import { createPipelineJobs } from '../areas/imports/pipeline.jobs.js';
import { createExportService } from '../areas/imports/export.js';
import { createExportRoutes } from '../areas/imports/export.routes.js';
import { createExportJobs } from '../areas/imports/export.jobs.js';
import { createImportRetention, createImportRetentionJobs } from '../areas/imports/retention.js';
import { createPaymentsResolver } from '../areas/setup/stripe-step.js';
import { createStripeEndpointCheck } from '../areas/setup/stripe-step.endpoints.js';
import { createWebhookHealthQuery, createWebhookInbox, type PaymentsResolver } from '../areas/billing/webhooks/inbox.js';
import { configureWebhookInboxRoutes } from '../areas/billing/webhooks/inbox.routes.js';
import { configureWebhookInboxJobs } from '../areas/billing/webhooks/inbox.jobs.js';
import { configureWebhookReplay } from '../cli/replay.js';
import { composeBillingWebhooks } from '../areas/billing/webhooks/handlers/composition.js';
import { createChargeRunner } from '../areas/billing/runner/index.js';
import { configureChargeRunner } from '../areas/billing/runner/runner.jobs.js';
import { createMembershipService } from '../areas/billing/memberships.js';
import { configureMemberships } from '../areas/billing/memberships.routes.js';
import { createPaymentService } from '../areas/billing/payments.js';
import { configurePayments } from '../areas/billing/payments.routes.js';
import { configurePackSales } from '../areas/billing/packs/sales.handlers.js';
import { createPackSalesService } from '../areas/billing/packs/sales.js';
import { configurePaymentDelivery, createLapsedRefundJobs } from '../areas/billing/payments.jobs.js';
import { createBillingAlerts, createDisputeAlertProvider, sendAlertJob } from '../areas/billing/alerts/index.js';
import { configureBillingAlerts } from '../areas/billing/alerts/alerts.jobs.js';
import { createAccountService } from '../infra/auth/accounts.js';
import { configureStaffAuth } from '../areas/staff/auth.routes.js';
import { configureAccount } from '../areas/staff/auth.account.js';
import { createEmailChangeService } from '../infra/auth/email-change.js';
import type { Jobs } from '../infra/jobs/index.js';

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
/** The app's flood limit per gym and client address each minute: `RATE_LIMIT_PER_MINUTE`, else the limiter's default. */
export function floodLimit(env: NodeJS.ProcessEnv): number | undefined {
  if (env.RATE_LIMIT_PER_MINUTE === undefined) return undefined;
  const value = Number(env.RATE_LIMIT_PER_MINUTE);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) throw new Error('RATE_LIMIT_PER_MINUTE must be an integer from 1 to 100000');
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
  // Both Google variables or neither: a malformed pair does not stop boot. The app starts without the install's client and
  // logs the variable and the reason once, and Health and Settings show it. Demo mode ignores them.
  googleFromEnvironment(env);
  // An unknown GYM_INTEGRATIONS value stops boot here, before the database opens.
  checkIntegrationsEnvironment(mode, env);
  await initializeDatabase(required(env, 'DATABASE_URL'), poolSize(env));
  const smtp = demo.enabled ? undefined : createSmtpResolver({ key, env });
  configureAuthCli({ resolveGymId: () => singleGymId(), smtpConfigured: (gymId) => smtp ? smtp.configured(gymId) : Promise.resolve(true) });
  return { key, mode, config, install, smtp };
}
/** Stripe events for each gym, verified by that gym's own Stripe settings; the CLI replays through the same inbox. */
function webhookInbox(paymentsFor: PaymentsResolver, jobs: Jobs) {
  const inbox = createWebhookInbox({ paymentsFor, jobs, gymSettings: createGymSettingsAccessor(), clock });
  configureWebhookReplay(inbox);
  return inbox;
}

/** Feature modules come from the entry point: core never imports module code. */
export interface RuntimeModules {
  readonly modules?: readonly ModuleDefinition[];
  /** Gives the modules the runtime's services before the routes mount. */
  readonly configureModules?: (services: { uploadsFor: ReturnType<typeof createRuntimeUploads>['forGym'];
    origin: (context: Context<RequestEnvironment>) => string; clock: typeof clock }) => void;
}
export interface Runtime {
  readonly app: ReturnType<typeof createApp>;
  readonly uploadsFor: ReturnType<typeof createRuntimeUploads>['forGym'];
  stop(): Promise<void>;
}
export async function startRuntime(env: NodeJS.ProcessEnv = process.env, composition: RuntimeModules = {}): Promise<Runtime> {
  // Only the server refuses the maintenance role in multi mode: `gym-app migrate` is the step that needs it.
  assertMaintenanceCredentials(env);
  const { key, mode, config: initialConfig, install, smtp } = await prepare(env);
  // Caddy is the only peer that can reach the app in the Compose deployment.
  const trustedProxy = env.TRUST_PROXY === 'true' ? () => true : undefined;
  // Behind Cloudflare's proxy, the client comes from CF-Connecting-IP, but only on requests Caddy forwarded from
  // Cloudflare's published ranges (core/rate-limit.ts, clientIp).
  const proxyTrust = { ...(trustedProxy ? { trustedProxy } : {}), ...(env.TRUST_CLOUDFLARE === 'true' ? { cloudflare: true } : {}) };
  const limit = floodLimit(env);
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
    clientIp: proxyTrust });
  const config = demo?.authConfig ?? initialConfig;
  const smtpConfigured = (gymId: string) => demo ? Promise.resolve(true) : smtp!.configured(gymId);
  // The install's GOOGLE_* variables win; otherwise a single-gym owner's stored client. Each Google request and the login methods look it up.
  const googleClients = createGoogleClientResolver({ key, env, tenancy: mode });
  const auth = createAuthService({ config, sendMagicLink: demo?.sendMagicLink ?? createAuthEmailSender((gymId) => smtp!.config(gymId)),
    google: createGoogleAuthExtension({ credentials: googleClients.credentials }) });
  configureLoginMethods(async (gymId) => {
    const configured = await smtpConfigured(gymId);
    return { password: passwordLogin(config, configured), magicLink: configured, ...(await googleClients.credentials(gymId) ? { google: true } : {}) };
  });
  const settings = createGymSettingsAccessor(), gymSettings = createSettingsService(), t = createTranslator(locales.en ?? {});
  // Member-facing mail goes through the gym's SMTP (or the demo outbox), with links on the gym's own origin.
  async function gymMail(gymId: string) {
    const [origin, mail, details] = await Promise.all([gymOrigin(gymId), demo ? Promise.resolve(null) : smtp!.config(gymId), gymSettings.get(gymId)]);
    if (!demo && !mail) throw new AppError('unavailable', 'Email is not configured for this gym');
    return { origin, email: demo ? demo.emailFor(gymId) : new SmtpEmail(mail!), t, gymName: details.name,
      memberEmailsEnabled: details.memberEmailsEnabled };
  }
  configureSignedLinkDelivery({ async prepare(gymId) {
    return { gymId, ...await gymMail(gymId) };
  } });

  // Restore state and activity leases live beside the staging directory, as in the maintenance CLI (single mode only).
  const restoreStaging = restoreStagingDirectory(env);
  const gate = restoreStaging ? new RestoreGate(dirname(restoreStaging)) : undefined;
  const queue = new PostgresJobs({ clock, listGyms: () => listGyms(), retention: { keep: [sendAlertJob] } });
  // Expired magic links and staff invitations are swept by one install job an hour, in either tenancy mode.
  const verificationSweep = registerVerificationSweep(queue, clock);
  // The public forms' named limits are counted in the database, so every process shares one window; each process remembers
  // the budgets it saw refused, and one job an hour removes expired counters.
  const intakeLimits = registerIntakeRateLimits(queue, clock);
  const bookingDelivery = createBookingDelivery({ jobs: queue, settings, clock,
    mailer: async gymId => demo ? demo.emailFor(gymId) : smtpMailer(smtp!)(gymId) });
  configureBookingJobs(bookingDelivery);
  configureBookingRoutes(bookingDelivery);
  configurePortalBookingRoutes(bookingDelivery);
  const accounts = createAccountService(config);
  configureStaffAuth({ accounts, config, smtpConfigured });
  // A login changes its own sign-in email through a link sent to the new address, in the gym's own mail and origin.
  configureAccount({ service: createEmailChangeService({ config }), smtpConfigured, mail: gymMail });
  // Webhooks and restore reconciliation publish a recorded dispute's alert through the same service as the hourly scan.
  const alerts = createBillingAlerts({ jobs: queue, settings: createGymSettingsAccessor(), accounts, clock, prepare: gymMail });
  configureBillingAlerts(alerts);
  // Ranks read attendance through the frozen interface; imports and exports need storage and the queue.
  const attendance = createAttendanceQueries({ clock });
  const criteria = configureRanks({ attendance, clock });
  const ranks = createRanksService({ clock, criteria });
  // The dashboard is configured after the payment service exists (below); portal progress reads through the same services.
  configurePortalProgress({ ranks, attendance });
  // Staff invitations use the gym's SMTP (or the demo outbox); photos use the gym's file storage.
  configureStaffProfiles({ invitations: createStaffInvitationService({ config, smtpConfigured,
    mailer: demo ? demo.emailFor : smtpMailer(smtp!) }), uploadsFor: uploads.forGym, origin: originFor });
  // Passwordless claims prove the address with a login link that returns to the portal claim page.
  const portalInvitations = createPortalInvitationService({ config, smtpConfigured,
    mailer: demo ? demo.emailFor : smtpMailer(smtp!),
    loginLink: async ({ gymId, email, claim }) =>
      auth.bind({ gymId, origin: await gymOrigin(gymId), clientIp: '127.0.0.1', smtpConfigured: true }).sendLoginLink(email, claim) });
  configurePortalAccess({ service: portalInvitations, origin: originFor });
  const gymKey = createGymKeyResolver({ key });
  configureKiosk({ pinSecret: gymKey, uploadsFor: uploads.forGym, clock });
  configureCheckinCodes({ gymKey, clock });
  const checkinCodes = createCheckinCodeService({ gymKey, clock });
  configureQrCheckin({ codes: checkinCodes, uploadsFor: uploads.forGym, clock });
  configurePortalCheckin(checkinCodes);
  // Signature images and rendered waiver PDFs use the gym's file storage.
  const documentDelivery = createWaiverDocumentDelivery({
    uploadsFor: uploads.forGym, originFor: gymOrigin, clock,
    key: new Uint8Array(hkdfSync('sha256', key, new Uint8Array(0), 'plaingym waiver documents v1', 32)),
  });
  const waivers = configureWaivers({ uploadsFor: uploads.forGym, clock, documentDelivery });
  configurePortalWaivers(waivers);
  // Trial and drop-in staff notices are queued after the intake commits and sent to owners and admins by a job.
  const publicNotices = createPublicStaffNotices({ jobs: queue, accounts, clock,
    // Ordinary installs can accept intake before SMTP is configured (the notice is then skipped); demos use the outbox.
    prepare: async gymId => (!demo && !await smtpConfigured(gymId)) ? null : gymMail(gymId) });
  configurePublicStaffNotices(publicNotices);
  // The public drop-in page shows the price of the charge type the gym chose in settings.
  configurePublicPages({ clock, waivers, uploadsFor: uploads.forGym, notifyStaff: publicNotices.publish, dropInFeeFor: createDropInFee() });
  const importPipeline = createImportPipeline({ uploadsFor: uploads.forGym, jobs: queue, clock });
  const exportService = createExportService({ uploadsFor: uploads.forGym, jobs: queue, clock });
  // Setup step 8 finishes with a committed run from this pipeline.
  configureImportStep({ imports: importPipeline, clock });
  // Normal installs use stored gym credentials; sandboxes resolve the shared test account.
  const paymentsFor = demo?.payments.paymentsFor ?? createPaymentsResolver({ key, clock });
  configureGoLive({ clock, smtpConfigured, paymentsConfigured: async gymId => Boolean(await paymentsFor(gymId)) });
  // Settings → Email, Payments and Backups reuse the setup steps' services with the runtime's key, auth rules and gym origins.
  // A confirmed backup change queues one snapshot through the backup job registered below (installs that take snapshots).
  configureIntegrations({ key, env, config, origin: gymOrigin, hasPassword: (userId) => accounts.hasPassword(userId), sandbox: Boolean(demo), clock,
    ...(gate && env.MAINTENANCE_DATABASE_URL ? { requestSnapshot: async (change: string) => { await queue.enqueueSystem('health.backup', { kind: 'manual' },
      { timezone: 'UTC', runAt: clock.now(), idempotencyKey: 'snapshot:' + change, maxAttempts: 3 }); } } : {}) });
  configureUpdateRoutes({ env });
  configureHealthStatus({ env, providers: [
    createStripeHealthProvider({ webhooks: createWebhookHealthQuery(), configured: async gymId => Boolean(await paymentsFor(gymId)) }),
    createChargeRunHealthProvider({ settings }),
    createAutoUpdateHealthProvider(),
  ] });
  async function requirePayments(gymId: string) {
    const provider = await paymentsFor(gymId);
    if (!provider) throw new AppError('unavailable', 'Stripe is not configured for this gym');
    return provider;
  }
  configureCampaigns(createCampaignsService({ jobs: queue, clock, paymentsFor: requirePayments,
    delivery: { prepare: async gymId => ({ gymId, ...await gymMail(gymId) }) } }));
  // Announcements send through the gym's SMTP (or the demo outbox, which needs no resolver) to the members it selects.
  configureAnnouncements(createAnnouncementsService({ jobs: queue, clock, smtp: smtp ?? { configured: async () => true },
    mailer: async gymId => {
      if (demo) return demo.emailFor(gymId);
      const email = await smtpMailer(smtp!)(gymId);
      if (!email) throw new AppError('unavailable', 'Email is not configured for this gym');
      return email;
    }, origin: gymOrigin, demoMode: Boolean(demo),
    ...(demo ? { demoEmailFor: demo.emailFor } : {}),
    async senderEmail(gymId, userId) {
      const email = await accounts.userEmail(gymId, userId);
      if (!email) throw new AppError('forbidden', 'Announcement sender has no login email');
      return email;
    } }));
  // Cancelling a session with the notice option queues one job that emails its booked and waitlisted members.
  configureCancellationNotice(createCancellationNotice({ jobs: queue, clock, origin: gymOrigin, demoMode: Boolean(demo),
    mailer: async gymId => demo ? demo.emailFor(gymId) : smtpMailer(smtp!)(gymId),
    ...(demo ? { demoEmailFor: demo.emailFor } : {}) }));
  const inbox = webhookInbox(paymentsFor, queue);
  configureWebhookInboxRoutes(inbox);
  configureWebhookInboxJobs(inbox);
  // Webhook handlers apply payment outcomes through the one invoice transition service, whose effects
  // (receipts, dunning, membership activation, staff notices) run as jobs. Before the worker starts.
  const checkout = createSignedLinkCheckout({ paymentsFor: requirePayments, originFor: gymOrigin, clock });
  // Join keeps its own membership service: the runtime's assignment callback would invoice sign-up fees separately.
  const join = configureJoin({ clock, waivers, checkout, uploadsFor: uploads.forGym, paymentsConfigured: async gymId => Boolean(await paymentsFor(gymId)),
    invitations: portalInvitations, accounts, ...(demo ? { testCardHint: demo.joinTestCardHint } : {}),
    key: new Uint8Array(hkdfSync('sha256', key, new Uint8Array(0), 'plaingym public join v1', 32)) });
  demo?.service.setJoinReadiness(join);
  const billing = composeBillingWebhooks({ inbox, jobs: queue, settings, paymentsFor, clock, prepare: gymMail, disputeAlerts: alerts,
    async afterCheckoutRecorded(gymId, linkId, sessionId) {
      try { await checkout.complete(gymId, linkId, sessionId); }
      // Revoked/expired links refuse completion without retrying an already-recorded card or payment.
      catch (error) { if (!(error instanceof AppError && error.code === 'not_found')) throw error; }
      // A paid join activates its people and sends the portal sign-in link once.
      await join.afterCheckout(gymId, linkId);
    },
    // A join also completes when staff record cash or a check, or a later pay link settles its invoice.
    afterInvoicePaid: (gymId, invoiceId) => join.afterInvoicePaid(gymId, invoiceId),
    staffRecipients: (gymId) => accounts.staffEmails(gymId, ['owner', 'admin']) });
  const runner = createChargeRunner({ settings, transitions: billing.transitions,
    jobs: queue, payments: requirePayments, clock, disputeAlerts: alerts });
  billing.attachRetry(runner.retry);
  // Only daily is monitored. Retry, assignment callbacks and staff collection keep the original runner.
  const monitored = monitorChargeRunner(runner, { clock, settings });
  configureChargeRunner(monitored);
  // The charge-run tile lists and dismisses the reports of the same runner the worker runs.
  configureChargeFailures(monitored);
  const memberships = createMembershipService({ clock, settings, onAssigned: runner.onAssigned });
  configureMemberships(memberships, { assigned: runner.collectAssigned });
  const detachCard = async (gymId: string, id: string, options?: DetachOptions) => (await requirePayments(gymId)).detachPaymentMethod(id, options);
  // Household PINs use the gym's random key; member photos use the gym's file storage. Erasure
  // detaches a household's revoked cards through the same callback and durable job as card removal, and
  // redacts the erased household's Stripe customer (name and email) with its own retrying job. The guard skips a
  // customer a household of the gym links again and audits each redaction.
  configureMembers({ pinSecret: gymKey, uploadsFor: uploads.forGym, clock, detachCard, jobs: queue,
    redactCustomer: guardRedaction(async (gymId, customerId) => (await requirePayments(gymId)).redactCustomer(customerId), { clock }) });
  const payments = createPaymentService({ settings, clock, jobs: queue, paymentsFor,
    transitions: billing.transitions, runner, detachCard });
  configurePayments(payments);
  // A zero-total pack sale settles at once through the publishing transitions, so its credits are granted without waiting for the hourly sweep.
  configurePackSales(createPackSalesService({ clock, settings, transitions: billing.transitions }));
  configureBillingDashboard({ settings, memberships, payments });
  // The dashboard reads the same services as portal progress, with the ranks criteria registry and clock; its
  // skipped-collections entry needs the payment service, so it is configured here.
  configureDashboard({ members: createMembersService({ clock }), ranks, attendance, notSeen: createNotSeenRead() }, [createDisputeAlertProvider(), createPinLimitWidgetProvider(),
    createPortalConfirmationWidgetProvider(), createSkippedCollectionsProvider({ settings, payments }),
    createFollowUpsDueProvider({ settings })]);
  configurePaymentDelivery({ notifications: billing.notifications, detachCard });
  // Portal billing seals its Checkout return into the signed-link receipt cookie, so both share one key.
  const receiptKey = new Uint8Array(hkdfSync('sha256', key, new Uint8Array(0), 'plaingym signed-link receipts v1', 32));
  configureLinkPages({ waivers, portalInvitations, checkout, receiptKey });
  configurePortalBilling({ checkout, receiptKey, uploadsFor: uploads.forGym });
  // Setup takes the runtime's key, origin and environment; the registry's unconfigured copies are replaced.
  const setupRoutes = install ? createSetupRoutes({ config: { key, origin: install, env } }) : [];
  const replaced = new Set(setupRoutes.map(r => r.id));
  composition.configureModules?.({ uploadsFor: uploads.forGym, origin: originFor, clock });
  const contributions = { ...areaContributions, modules: composition.modules ?? [],
    routes: [...(areaContributions.routes ?? []).filter(r => !replaced.has(r.id)), ...setupRoutes,
      ...createPipelineRoutes(importPipeline), ...createExportRoutes(exportService),
      createUploadDownloadRoute({ uploadsFor: uploads.forGym, origin: originFor })],
    jobs: [...areaContributions.jobs ?? [], ...createPipelineJobs(importPipeline), ...createExportJobs(exportService), ...createMemberPhotoJobs(uploads.forGym),
      ...createPortalInvitationExpiryJobs(), ...createEmailDeliveryJobs(),
      // Default lane: the per-gym cap of 1 keeps this sweep apart from the duplicate-refund workers.
      ...createLapsedRefundJobs({ clock, transitions: billing.transitions, payments: requirePayments }),
      ...createImportRetentionJobs(createImportRetention({ uploadsFor: uploads.forGym, clock })),
      ...createUploadSweepJobs({ uploadsFor: uploads.forGym, backupsConfigured: () => mode === 'multi' ? Promise.resolve(false) : backupsConfigured(key),
        ...(env.MAINTENANCE_DATABASE_URL ? { locked: (action) => new PostgresMaintenance(env.MAINTENANCE_DATABASE_URL!).locked(action) } : {}) })] };
  const session = sessionMiddleware({ auth, smtpConfigured,
    principal: (userId, context, bound) => createPortalPrincipalLoader()(context.get('context').gym.gymId, userId, bound),
    resolve: (context) => {
    const address = clientIp(context, proxyTrust);
    return { gymId: context.get('context').gym.gymId, origin: originFor(context), clientIp: address === 'unknown' ? '0.0.0.0' : address };
  } });
  // Photos load from the uploads bucket's signed URLs when S3 is configured. A host the policy can't name (such as a
  // Compose service with an underscore) is left out of the enforced policy and logged rather than refusing to start: a
  // browser can't reach such a host anyway, so leaving it out blocks no photo that would have loaded.
  const bucketImages = (() => {
    if (!uploads.imageOrigin) return [];
    try { return imageOrigins([uploads.imageOrigin]); }
    catch (error) { logError('runtime.csp.image_origin_skipped', {}, error); return []; }
  })();
  const kioskSession = createKioskAuthMiddleware({ ...proxyTrust, session });
  // One map, passed to the app and refilled in place: the CSP report route reads it live and never queries the database.
  const reportHostnames = new Map<string, string>();
  const app = createApp({
    contributions, clock, resolveGym: createTenantResolver({ mode }), tenancy: mode, authorize: createPortalAuthorization(),
    // A waiver PDF may be up to 10 MiB; the default cap would stop it before the handler.
    bodyLimits: { ...defaultBodyLimits, routes: { ...defaultBodyLimits.routes, '/api/waivers/template-documents': documentByteLimit } },
    ...(mode === 'multi' ? { cspReportHostnames: reportHostnames } : {}),
    // Signed-link routes resolve their own bearer after normal session loading.
    session: (context, next) => context.req.path.startsWith('/api/links/') ? session(context, next) : kioskSession(context, next),
    origin: originFor, ...(install ? { installOrigin: install } : {}), strictTransportSecurity: env.NODE_ENV === 'production',
    rateLimit: { ...proxyTrust, ...(limit ? { limit } : {}) },
    ...(demo ? { restoreGate: demoWebhookMiddleware({ configured: Boolean(env.DEMO_STRIPE_TEST_KEY), inbox, demoGyms: demo.payments.demoGyms,
      ...(gate ? { restoreGate: gate.middleware() } : {}) }) } : gate ? { restoreGate: gate.middleware() } : {}),
    ...(env.SOURCE_URL ? { sourceUrl: env.SOURCE_URL } : {}),
    ...(env.SETUP_TOKEN ? { setupToken: env.SETUP_TOKEN } : {}), ...(demo ? { skipSetup: demo.skipSetup } : {}),
    ...(bucketImages.length ? { contentSecurity: { imageOrigins: bucketImages } } : {}),
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
  const sweep = async () => {
    if (gate) { if (!await gate.isClosed()) await gate.activity(async () => { await verificationSweep.scheduleDue(); await intakeLimits.scheduleDue(); }); }
    else { await verificationSweep.scheduleDue(); await intakeLimits.scheduleDue(); }
  };
  const sweepTimer = setInterval(() => { sweep().catch(report); }, 60_000);
  sweepTimer.unref();
  await sweep().catch(report);
  // The report route's hostname map (multi mode): read under a restore-gate lease, never from a report request, one
  // refresh at a time, then swapped in place with no await between clearing and refilling.
  let hostnameTimer: NodeJS.Timeout | undefined, hostnameRefresh: Promise<void> | undefined, hostnamesStopped = false;
  if (mode === 'multi') {
    const refresh = async () => {
      if (hostnamesStopped) return;
      if (gate && await gate.isClosed()) return;
      const snapshot = await (gate ? gate.activity(() => reportHostnameSnapshot()) : reportHostnameSnapshot());
      if (hostnamesStopped) return;
      reportHostnames.clear();
      for (const [hostname, gymId] of snapshot) reportHostnames.set(hostname, gymId);
    };
    const run = () => {
      hostnameRefresh ??= refresh().catch(report).finally(() => { hostnameRefresh = undefined; });
      return hostnameRefresh;
    };
    hostnameTimer = setInterval(() => { void run(); }, 60_000);
    hostnameTimer.unref();
    await run();
  }
  const worker = startJobsWorker(queue, { onError: report,
    ...(gate ? { paused: () => gate.isClosed(), around: (execute: () => Promise<void>) => gate.activity(execute) } : {}) });

  // Each gym's stored Stripe webhook endpoint is brought up to this release's events and API version. It runs in the
  // background: a Stripe outage never delays startup, and the next start or Stripe settings save checks again. Sandboxes
  // use the shared test account and register nothing.
  let stopping = false, endpointCheck: Promise<void> | undefined;
  if (!demo) {
    const check = createStripeEndpointCheck({ key, clock, gyms: () => listGyms(), origin: gymOrigin, stopped: () => stopping });
    endpointCheck = (async () => {
      if (!gate) return check.run();
      if (!await gate.isClosed()) await gate.activity(() => check.run());
    })().catch(report);
  }

  return { app, uploadsFor: uploads.forGym, async stop() {
    stopping = true;
    if (backupTimer) clearInterval(backupTimer);
    if (demoTimer) clearInterval(demoTimer);
    clearInterval(sweepTimer);
    hostnamesStopped = true;
    if (hostnameTimer) clearInterval(hostnameTimer);
    try { await worker.stop(); await endpointCheck; await hostnameRefresh; } finally { intakeLimits.reset(); uploads.close(); await closeDatabase(); }
  } };
}

/** `gym-app <command>`: the restore command manages its own connections; the others use the app database. */
export async function runCommandLine(args: readonly string[], io: CommandIO, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (args[0] === 'restore') return runCli(args, io);
  if (args[0] === 'setup-link') return createSetupLinkCommand(env).run(args.slice(1), io);
  // Migrating needs only the maintenance role, as in the container entrypoint.
  if (args[0] === 'migrate') return runCli(args, io);
  try {
    const { key } = await prepare(env), demo = demoBootCheck(env);
    const paymentsFor = demo.enabled ? createDemoPayments({ config: demo, clock }).paymentsFor : createPaymentsResolver({ key, clock });
    webhookInbox(paymentsFor, new PostgresJobs({ clock }));
  }
  catch (error) { io.stderr(error instanceof Error ? error.message : 'Startup failed'); return 1; }
  try { return await runCli(args, io); } finally { await closeDatabase(); }
}
