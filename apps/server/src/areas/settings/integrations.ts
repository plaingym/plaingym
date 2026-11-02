// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, isNotNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { forGym, gyms, households, paymentAttempts, paymentMethods, payments, revisionGuard, assertRevised, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { backupDestinationSchema, type BackupsIntegration, type ConfirmBackupKeyRequest, type CreateBackupKeyRequest, type EmailIntegration,
  type Integrations, type RemoveEmailIntegrationRequest, type SaveEmailIntegrationRequest, type SaveStripeIntegrationRequest } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';
import { logError } from '../../core/log.js';
import { passwordLogin, type AuthConfig } from '../../infra/auth/config.js';
import { stripeTransport } from '../../infra/payments/stripe.js';
import { StripePermissionError } from '../../infra/payments/setup.js';
import type { PaymentTransport } from '../../infra/payments/transport.js';
import { createS3Client, S3BackupObjectStore } from '../../infra/storage/index.js';
import { setupTestMessage } from '../../emails/setup/setup.js';
import { createStripeConnection, readStripeConfig, restrictedKeyMode, type StripeConfig, type StripeProvisioner } from '../setup/stripe-step.js';
import { backupColumns, backupKeyPair, newBlobKey, recipientOf } from '../setup/backup-key.js';
import { encryptSmtpConfig, sendSmtpTest, smtpFromEnvironment, storedSmtpFromRequest, storedSmtpSchema, type SendSmtpTest } from './smtp.js';

type Gym = typeof gyms.$inferSelect;
/** A new destination and key waiting for the owner to prove they saved the private key. Kept in the gym's opaque settings. */
const pendingBackupSchema = z.strictObject({ destination: backupDestinationSchema, publicKey: z.string(), s3Config: z.string() });
type PendingBackup = z.infer<typeof pendingBackupSchema>;
const defaultRetentionBytes = 8_000_000_000n;
const smtpPorts = [25, 465, 587, 2525];
/** Lists an empty prefix with the submitted credentials: a wrong endpoint, bucket or key fails here, without writing anything. */
async function listDestination(destination: CreateBackupKeyRequest['destination']): Promise<void> {
  const client = createS3Client({ region: destination.region, endpoint: destination.endpoint,
    credentials: { accessKeyId: destination.accessKeyId, secretAccessKey: destination.secretAccessKey } });
  try { await new S3BackupObjectStore({ client, bucket: destination.bucket }).listObjects('snapshots/00000000-0000-0000-0000-000000000000/'); }
  finally { client.destroy(); }
}

export interface IntegrationsOptions {
  /** `APP_ENCRYPTION_KEY`: stored credentials are encrypted with it. */
  key: Buffer;
  /** The install's environment, for its `SMTP_*` fallback. */
  env: NodeJS.ProcessEnv;
  /** The runtime's auth configuration: tenancy and `AUTH_PASSWORD_LOGIN`. */
  config: AuthConfig;
  /** The gym's public origin, where Stripe sends its webhooks. */
  origin: (gymId: string) => Promise<string>;
  /** Whether a login has a password of its own. */
  hasPassword: (userId: string) => Promise<boolean>;
  /** Demo mode: email and payments are the demo's own, and nothing here can change. */
  sandbox?: boolean;
  /**
   * Queues a snapshot with the backup settings just confirmed, so the new destination and key hold one right away.
   * `key` is unique to the change. Absent where the install takes no snapshots (such as a server run without the
   * maintenance role); the hourly schedule then picks the new settings up.
   */
  requestSnapshot?: (key: string) => Promise<void>;
  /** Proves a new backup destination answers with its credentials before a key is made for it; tests replace it. */
  checkDestination?: (destination: CreateBackupKeyRequest['destination']) => Promise<void>;
  clock?: Clock; scope?: typeof forGym;
  /** Tests replace SMTP delivery, Stripe provisioning and the Stripe transport used to identify an account. */
  sendTest?: SendSmtpTest; provisioner?: (key: string) => StripeProvisioner; transport?: (key: string) => PaymentTransport;
}

/**
 * Email, Stripe and backups after setup (owners only). Each change goes through the same service parts as its setup
 * step, writes an audit without credentials, and uses the gym revision like the other settings sections. Nothing returned,
 * audited or logged here contains an SMTP password, a Stripe key or signing secret, storage credentials or a private key.
 */
export function createIntegrationsService(options: IntegrationsOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const sandbox = options.sandbox ?? false, single = options.config.tenancy === 'single';
  // A sandbox mails through the demo outbox and never reads the install's SMTP settings (as the runtime doesn't).
  const installSmtp = !sandbox && smtpFromEnvironment(options.env) !== null;
  const stripe = createStripeConnection({ provisioner: options.provisioner });
  const transportFor = options.transport ?? ((apiKey: string) => stripeTransport(apiKey));

  const readGym = (tx: Transaction, gymId: string) => tx.select().from(gyms).where(eq(gyms.id, gymId));
  async function gymRow(gymId: string): Promise<Gym> {
    const [gym] = await scope(gymId, (tx) => readGym(tx, gymId));
    if (!gym) throw new AppError('not_found', 'Gym not found');
    return gym;
  }
  function pendingBackup(gym: Gym): PendingBackup | null {
    const parsed = pendingBackupSchema.safeParse((gym.settings as { integrations?: { backup?: unknown } }).integrations?.backup);
    return parsed.success ? parsed.data : null;
  }
  function gymSmtp(gym: Gym) {
    if (!gym.smtpConfig) return null;
    try { return storedSmtpSchema.parse(JSON.parse(decryptSecret(options.key, 'smtp_config', gym.smtpConfig))); }
    catch (error) { logError('settings.smtp_config_unreadable', { gymId: gym.id }, error); return null; }
  }
  /** The email settings an audit records: never the username or password. */
  function emailAudit(gym: Gym) {
    const smtp = gymSmtp(gym);
    return { source: gym.smtpConfig ? 'gym' : installSmtp ? 'install' : 'none',
      host: smtp?.host ?? null, port: smtp?.port ?? null, security: smtp?.security ?? null, from: smtp?.from ?? null };
  }
  const signIn = (emailConfigured: boolean) => ({ password: passwordLogin(options.config, emailConfigured), magicLink: emailConfigured });
  async function email(gym: Gym, userId: string): Promise<EmailIntegration> {
    const { source, host, port, security, from } = emailAudit(gym);
    // A sandbox signs in through the demo outbox, whatever is stored.
    const now = signIn(sandbox || source !== 'none');
    const afterRemove = source === 'gym' && !sandbox ? signIn(installSmtp) : null;
    const removeBlocked = afterRemove !== null && !afterRemove.magicLink && !(afterRemove.password && await options.hasPassword(userId));
    return { source: source as EmailIntegration['source'], host, port, security, from, signIn: now, signInAfterSave: signIn(true),
      signInAfterRemove: afterRemove, removeBlocked };
  }
  /**
   * Customers, cards and card payments belong to the Stripe account that created them. Returns null when the gym has none,
   * otherwise the Stripe paths of a few of them (newest first), which a restricted key with the setup permissions can read
   * (customers, PaymentIntents, charges and payment methods are all readable). Several, so that one stale or imported ID
   * the account doesn't have can't block a key change on its own.
   */
  async function stripeReference(tx: Transaction): Promise<{ paths: string[] } | null> {
    const customers = await tx.select({ id: households.stripeCustomerId }).from(households)
      .where(isNotNull(households.stripeCustomerId)).orderBy(desc(households.id)).limit(3);
    const attempts = await tx.select({ id: paymentAttempts.stripeCustomerId }).from(paymentAttempts).orderBy(desc(paymentAttempts.id)).limit(1);
    const paid = await tx.select({ intent: payments.paymentIntentId, charge: payments.chargeId }).from(payments)
      .where(or(isNotNull(payments.paymentIntentId), isNotNull(payments.chargeId))).orderBy(desc(payments.id)).limit(2);
    const cards = await tx.select({ id: paymentMethods.processorId }).from(paymentMethods).orderBy(desc(paymentMethods.id)).limit(1);
    const paths = [...customers.map((row) => '/v1/customers/' + row.id), ...attempts.map((row) => '/v1/customers/' + row.id),
      ...paid.map((row) => row.intent ? '/v1/payment_intents/' + row.intent : '/v1/charges/' + row.charge),
      ...cards.map((row) => '/v1/payment_methods/' + row.id)];
    return paths.length ? { paths: [...new Set(paths)] } : null;
  }
  function backups(gym: Gym): BackupsIntegration | null {
    if (!single || sandbox) return null;
    const destination = backupDestinationSchema.safeParse(gym.backupDestination);
    const pending = pendingBackup(gym);
    return { configured: Boolean(gym.backupPublicKey && gym.backupBlobKey && gym.s3Config && gym.backupDestination),
      destination: destination.success ? destination.data : null, publicKey: gym.backupPublicKey,
      pending: pending ? { destination: pending.destination, publicKey: pending.publicKey } : null,
      retentionBudgetBytes: Number(gym.backupRetentionBytes ?? defaultRetentionBytes) };
  }
  async function present(gymId: string, userId: string): Promise<Integrations> {
    const { gym, locked } = await scope(gymId, async (tx) => {
      const [row] = await readGym(tx, gymId);
      if (!row) throw new AppError('not_found', 'Gym not found');
      return { gym: row, locked: (await stripeReference(tx)) !== null };
    });
    const config = readStripeConfig(options.key, gym.stripeConfig, gymId);
    return { email: await email(gym, userId),
      payments: { configured: config !== null, mode: config?.mode ?? null, webhookRegistered: Boolean(config?.endpointId), accountLocked: locked },
      backups: backups(gym), sandbox, revision: gym.revision };
  }
  const userOf = (context: MutationContext) => {
    if (context.actor.kind !== 'user') throw new AppError('forbidden', 'Owner access required');
    return context.actor.userId;
  };
  function assertChangeable() {
    if (sandbox) throw new AppError('forbidden', 'A sandbox uses the demo’s own email and payments');
  }
  function assertBackups() {
    if (!single || sandbox) throw new AppError('not_found', 'Backups are not available on this install');
  }
  /** Fails fast on a stale revision before any network call; the save checks it again. */
  async function assertCurrent(gymId: string, revision: number): Promise<Gym> {
    const gym = await gymRow(gymId);
    assertRevised(gym.revision === revision ? [gym] : []);
    return gym;
  }
  /** One short transaction: lock the gym, check the revision, apply the change and write its audit. */
  async function save(context: MutationContext, revision: number,
    change: (gym: Gym, tx: Transaction) => Promise<{ set: Partial<Gym>; action: string; before: Record<string, unknown>; after: (gym: Gym) => Record<string, unknown> }>) {
    const userId = userOf(context);
    return scope(context.gymId, async (tx) => {
      const [before] = await readGym(tx, context.gymId).for('update');
      if (!before) throw new AppError('not_found', 'Gym not found');
      assertRevised(before.revision === revision ? [before] : []);
      const plan = await change(before, tx);
      const guard = revisionGuard(gyms.revision, revision);
      const after = assertRevised(await tx.update(gyms).set({ ...plan.set, revision: guard.next, updatedAt: clock.now() })
        .where(and(eq(gyms.id, context.gymId), guard.matches)).returning());
      await writeAudit(tx, { gymId: context.gymId, actorKind: 'user', actorUserId: userId, action: plan.action, targetType: 'gym',
        targetId: context.gymId, before: plan.before, after: { ...plan.after(after), revision: after.revision }, occurredAt: clock.now() });
      return after;
    });
  }
  /**
   * Whether `apiKey` can read an object the gym's current Stripe account created: a key for another account (or the other
   * mode) gets a 404 `resource_missing`. Stripe keeps deleted customers readable, so a deleted one still matches.
   */
  async function sameAccount(apiKey: string, reference: { paths: string[] }): Promise<boolean> {
    const transport = transportFor(apiKey);
    for (const path of reference.paths) {
      if (!/^\/v1\/(customers\/cus|payment_intents\/pi|charges\/(ch|py)|payment_methods\/(pm|card|src))_[A-Za-z0-9_]+$/.test(path)) continue;
      try { await transport.request({ method: 'GET', path }); return true; }
      catch (error) {
        const value = error as { code?: unknown; statusCode?: unknown };
        if (!(value.code === 'resource_missing' && value.statusCode === 404)) throw error;
      }
    }
    return false;
  }
  /** Stripe's answer as a safe error: a missing permission names its resource; anything else is unavailable and logged without its message. */
  function stripeFailure(gymId: string, error: unknown): AppError {
    if (error instanceof AppError) return error;
    if (error instanceof StripePermissionError)
      return new AppError('invalid_request', 'Check the Stripe permission for ' + error.resource, { restrictedKey: ['missing_permission'] });
    logError('settings.stripe_key_failed', { gymId }, error);
    return new AppError('unavailable', 'Stripe could not be reached or refused the key');
  }

  return {
    /** The gym's integrations for the signed-in owner (their own password decides whether email can be removed). */
    async get(gymId: string, userId: string): Promise<Integrations> { return present(gymId, userId); },

    /** Sends a test message through the submitted settings and saves them only if it is accepted. */
    async saveEmail(context: MutationContext, input: SaveEmailIntegrationRequest): Promise<{ test: 'sent' | 'failed'; integrations: Integrations }> {
      assertChangeable();
      const userId = userOf(context);
      // On a multi-gym install the test connection is made for a tenant: only SMTP ports, so it can't probe other services.
      if (!single && !smtpPorts.includes(input.port))
        throw new AppError('invalid_request', 'Use an SMTP port: ' + smtpPorts.join(', '), { port: ['port_not_allowed'] });
      await assertCurrent(context.gymId, input.revision);
      const stored = storedSmtpFromRequest(input);
      if (!await sendSmtpTest(stored, setupTestMessage(input.testTo), options.sendTest))
        return { test: 'failed', integrations: await present(context.gymId, userId) };
      await save(context, input.revision, async (gym) => ({ set: { smtpConfig: encryptSmtpConfig(options.key, stored) },
        action: 'integrations.email_saved', before: emailAudit(gym), after: emailAudit }));
      return { test: 'sent', integrations: await present(context.gymId, userId) };
    },

    /** The gym falls back to the install's `SMTP_*`. Refused while it would leave the signed-in owner no way to sign in. */
    async removeEmail(context: MutationContext, input: RemoveEmailIntegrationRequest): Promise<Integrations> {
      assertChangeable();
      const userId = userOf(context);
      const gym = await assertCurrent(context.gymId, input.revision);
      if (!gym.smtpConfig) throw new AppError('conflict', 'The gym has no email settings of its own', { email: ['not_configured'] });
      if ((await email(gym, userId)).removeBlocked)
        throw new AppError('conflict', 'Email is your only way to sign in: set a password first', { email: ['only_sign_in'] });
      await save(context, input.revision, async (before) => {
        if (!before.smtpConfig) throw new AppError('conflict', 'The gym has no email settings of its own', { email: ['not_configured'] });
        return { set: { smtpConfig: null }, action: 'integrations.email_removed', before: emailAudit(before), after: emailAudit };
      });
      return present(context.gymId, userId);
    },

    /**
     * Replaces the restricted key: the same permission probe and webhook endpoint lifecycle as setup. Once the gym has
     * Stripe customers, cards or card payments, the new key must be in the same mode and read at least one of them.
     */
    async saveStripe(context: MutationContext, input: SaveStripeIntegrationRequest): Promise<Integrations> {
      assertChangeable();
      const userId = userOf(context), gymId = context.gymId;
      const mode = restrictedKeyMode(input.restrictedKey);
      const { gym, reference } = await scope(gymId, async (tx) => {
        const [row] = await readGym(tx, gymId);
        if (!row) throw new AppError('not_found', 'Gym not found');
        return { gym: row, reference: await stripeReference(tx) };
      });
      assertRevised(gym.revision === input.revision ? [gym] : []);
      const previous = readStripeConfig(options.key, gym.stripeConfig, gymId);
      const origin = await options.origin(gymId);
      let connected: { config: StripeConfig; reused: boolean };
      if (reference && previous && previous.mode !== mode)
        throw new AppError('conflict', 'Stripe customers and payments exist in ' + previous.mode + ' mode', { restrictedKey: ['mode_locked'] });
      try {
        // After the permission probe, so a key missing a permission is told which one; before any endpoint is registered.
        connected = await stripe.connect(gymId, origin, input.revision, input.restrictedKey, previous, async () => {
          if (reference && !await sameAccount(input.restrictedKey, reference))
            throw new AppError('conflict', 'The key belongs to another Stripe account', { restrictedKey: ['account_locked'] });
        });
      } catch (error) { throw stripeFailure(gymId, error); }
      const { config, reused } = connected;
      // A failed save leaves an unreferenced endpoint, never active credentials; the next successful save retires it.
      await save(context, input.revision, async (before, tx) => {
        // A customer or payment recorded while Stripe was called would need the account check, which ran without one.
        if (!reference && (await stripeReference(tx)) !== null)
          throw new AppError('conflict', 'Stripe customers were recorded while the key was checked; try again');
        const was = readStripeConfig(options.key, before.stripeConfig, gymId);
        return { set: { stripeConfig: encryptSecret(options.key, 'stripe_config', JSON.stringify(config)) }, action: 'integrations.stripe_saved',
          before: { mode: was?.mode ?? null, endpointId: was?.endpointId ?? null },
          after: () => ({ mode: config.mode, endpointId: config.endpointId, endpointReused: reused }) };
      });
      await stripe.retireStale(gymId, origin, previous, config, reused);
      return present(gymId, userId);
    },

    /**
     * A new key pair for a new or changed destination. The private key is returned once; the destination and key wait in
     * the gym's settings, and snapshots keep using the current ones until `confirmBackupKey`.
     */
    async createBackupKey(context: MutationContext, input: CreateBackupKeyRequest): Promise<{ privateKey: string; publicKey: string; integrations: Integrations }> {
      assertBackups();
      const userId = userOf(context);
      await assertCurrent(context.gymId, input.revision);
      // A typo in the endpoint, bucket or credentials would otherwise replace working backups with failing ones on confirmation.
      try { await (options.checkDestination ?? listDestination)(input.destination); }
      catch (error) {
        logError('settings.backup_destination_check_failed', { gymId: context.gymId }, error);
        throw new AppError('invalid_request', 'The storage destination refused the request', { destination: ['unreachable'] });
      }
      const { privateKey, publicKey } = await backupKeyPair();
      const { destination, s3Config } = backupColumns(options.key, input.destination);
      await save(context, input.revision, async (gym) => {
        const settings = gym.settings as { integrations?: Record<string, unknown> };
        return { set: { settings: { ...settings, integrations: { ...settings.integrations, backup: { destination, publicKey, s3Config } satisfies PendingBackup } } },
          action: 'integrations.backup_key_created', before: { destination: backups(gym)?.destination ?? null, publicKey: gym.backupPublicKey },
          after: () => ({ pendingDestination: destination, pendingPublicKey: publicKey }) };
      });
      return { privateKey, publicKey, integrations: await present(context.gymId, userId) };
    },

    /** Activates the pending destination and key once the pasted private key matches. The blob key is kept: see `newBlobKey`. */
    async confirmBackupKey(context: MutationContext, input: ConfirmBackupKeyRequest): Promise<Integrations> {
      assertBackups();
      const userId = userOf(context);
      const publicKey = await recipientOf(input.privateKey);
      const saved = await save(context, input.revision, async (gym) => {
        const pending = pendingBackup(gym);
        if (!pending) throw new AppError('conflict', 'Generate a new backup key first', { privateKey: ['no_pending_key'] });
        if (pending.publicKey !== publicKey) throw new AppError('invalid_request', 'Backup key does not match', { privateKey: ['mismatch'] });
        // The pending credentials sit in opaque settings, which a restore to a new APP_ENCRYPTION_KEY does not re-encrypt:
        // only credentials this install can read become active.
        try { decryptSecret(options.key, 's3_config', pending.s3Config); }
        catch { throw new AppError('conflict', 'Generate a new backup key first', { privateKey: ['no_pending_key'] }); }
        const settings = gym.settings as { integrations?: Record<string, unknown> };
        const integrations = { ...settings.integrations };
        delete integrations.backup;
        return { set: { backupDestination: pending.destination, s3Config: pending.s3Config,
          backupPublicKey: publicKey, backupBlobKey: gym.backupBlobKey ?? newBlobKey(options.key),
          backupRetentionBytes: gym.backupRetentionBytes ?? defaultRetentionBytes, settings: { ...settings, integrations } },
        action: 'integrations.backup_key_confirmed', before: { destination: backups(gym)?.destination ?? null, publicKey: gym.backupPublicKey },
        after: (after) => ({ destination: backups(after)?.destination ?? null, publicKey: after.backupPublicKey }) };
      });
      // The change is saved either way; a snapshot that can't be queued now is taken by the next hourly run.
      try { await options.requestSnapshot?.('settings:' + context.gymId + ':' + saved.revision); }
      catch (error) { logError('settings.backup_snapshot_request_failed', { gymId: context.gymId }, error); }
      return present(context.gymId, userId);
    },
  };
}
export type IntegrationsService = ReturnType<typeof createIntegrationsService>;

let configured: IntegrationsService | undefined;
/** The runtime passes its key, environment, auth configuration, gym origin and account lookup. */
export function configureIntegrations(options: IntegrationsOptions): void { configured = createIntegrationsService(options); }
export function integrationsService(): IntegrationsService {
  if (!configured) throw new AppError('unavailable', 'Integrations are not configured');
  return configured;
}
