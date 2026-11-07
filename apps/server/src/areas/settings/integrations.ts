// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, notInArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { auditEvents, forGym, gyms, households, invoices, paymentAttempts, paymentMethods, payments, refunds, revisionGuard, assertRevised,
  signedLinks, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { backupDestinationSchema, type BackupsIntegration, type ConfirmBackupKeyRequest, type CreateBackupKeyRequest, type EmailIntegration,
  type Integrations, type RemoveEmailIntegrationRequest, type SaveEmailIntegrationRequest, type SaveStripeIntegrationRequest, type StripeTestData,
  type GoogleLogin, type RemoveGoogleLoginRequest, type SaveGoogleLoginRequest,
  stripeTestPaymentReference, terminalDisputeStatuses } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';
import { logError } from '../../core/log.js';
import { gymIntegrationsEditable } from '../../core/tenancy.js';
import { passwordLogin, type AuthConfig } from '../../infra/auth/config.js';
import { StripePayments, stripeTransport } from '../../infra/payments/stripe.js';
import { StripePermissionError } from '../../infra/payments/setup.js';
import type { PaymentTransport } from '../../infra/payments/transport.js';
import { setupTestMessage } from '../../emails/setup/setup.js';
import { createStripeConnection, readStripeConfig, restrictedKeyMode, type StripeConfig, type StripeProvisioner } from '../setup/stripe-step.js';
import { backupColumns, backupKeyPair, newBlobKey, recipientOf } from '../setup/backup-key.js';
import { customerUnlinkedAction, stripeTestClearedAction as testClearedAction } from '../billing/customers.js';
import { encryptSmtpConfig, readSmtpSchema, sendSmtpTest, smtpFromEnvironment, storedSmtpFromRequest, type SendSmtpTest } from './smtp.js';
import { createGoogleClientResolver, encryptGoogleConfig, readGoogleConfig } from './google-login.js';
import { readStoredSecret } from './unreadable-secret.js';
import { requireBackupDestination, type CheckBackupDestination } from './backup-destination.js';

type Gym = typeof gyms.$inferSelect;
/** A new destination and key waiting for the owner to prove they saved the private key. Kept in the gym's opaque settings. */
// Read from the gym's settings: a newer release may store more keys, which this one ignores after a rollback.
const storedDestinationSchema = z.object(backupDestinationSchema.shape);
const pendingBackupSchema = z.object({ destination: storedDestinationSchema, publicKey: z.string(), s3Config: z.string() });
type PendingBackup = z.infer<typeof pendingBackupSchema>;
const defaultRetentionBytes = 8_000_000_000n;
const smtpPorts = [25, 465, 587, 2525];
/** Invoices a charge or Checkout can still pay: their sessions and reservations are the open ones a switch drops. */
const payableStatuses = ['open', 'past_due'];
/** How long a switch's request waits for the old test key to retire the dropped Stripe objects; the rest finish after it. */
const retireBudgetMs = 10_000;
/** The final status a switch from test to live gives the open disputes of the payments it marks as test. */
const closedTestDispute = 'closed';

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
  checkDestination?: CheckBackupDestination;
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
  const integrationsEditable = gymIntegrationsEditable(options.config.tenancy, options.env);
  // A sandbox mails through the demo outbox and never reads the install's SMTP settings (as the runtime doesn't).
  const installSmtp = !sandbox && smtpFromEnvironment(options.env) !== null;
  const google = createGoogleClientResolver({ key: options.key, env: options.env, tenancy: options.config.tenancy, scope });
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
    return readStoredSecret(options.key, 'smtp_config', gym.id, gym.smtpConfig, () =>
      readSmtpSchema.parse(JSON.parse(decryptSecret(options.key, { secretClass: 'smtp_config', owner: gym.id }, gym.smtpConfig!))));
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
    // Removing the gym's email leaves the install's, the owner's password and the gym's Google client (the install's or a stored one).
    const removeBlocked = afterRemove !== null && !afterRemove.magicLink && !(afterRemove.password && await options.hasPassword(userId))
      && !await google.credentials(gym.id);
    return { source: source as EmailIntegration['source'], host, port, security, from, signIn: now, signInAfterSave: signIn(true),
      signInAfterRemove: afterRemove, removeBlocked };
  }
  /**
   * The latest switch from test to live (its audit's UUIDv7 ID): attempts, card payments and cards recorded before it are
   * test-mode, kept for the books, and no longer tie the gym to a Stripe account. Null when the gym never switched.
   */
  async function testBoundary(tx: Transaction, gymId: string): Promise<string | null> {
    const [row] = await tx.select({ id: auditEvents.id }).from(auditEvents)
      .where(and(eq(auditEvents.action, testClearedAction), eq(auditEvents.targetId, gymId)))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1);
    return row?.id ?? null;
  }
  /**
   * Customers, cards and card payments belong to the Stripe account that created them. Returns null when the gym has none,
   * otherwise the Stripe paths of a few of them (newest first), which a restricted key with the setup permissions can read
   * (customers, PaymentIntents, charges and payment methods are all readable). Several, so that one stale or imported ID
   * the account doesn't have can't block a key change on its own. `customersOnly` is true when only households hold them
   * (no attempts, card payments or cards): with no Stripe settings, those are imported IDs. Test-mode records from before
   * a switch to live don't count (`testBoundary`); the switch cleared every household's customer ID.
   */
  async function stripeReference(tx: Transaction, gymId: string): Promise<{ paths: string[]; customersOnly: boolean } | null> {
    const boundary = await testBoundary(tx, gymId);
    const since = (id: typeof payments.id | typeof paymentAttempts.id | typeof paymentMethods.id) => boundary ? gt(id, boundary) : undefined;
    const customers = await tx.select({ id: households.stripeCustomerId }).from(households)
      .where(isNotNull(households.stripeCustomerId)).orderBy(desc(households.id)).limit(3);
    const attempts = await tx.select({ id: paymentAttempts.stripeCustomerId }).from(paymentAttempts)
      .where(since(paymentAttempts.id)).orderBy(desc(paymentAttempts.id)).limit(1);
    const paid = await tx.select({ intent: payments.paymentIntentId, charge: payments.chargeId }).from(payments)
      .where(and(or(isNotNull(payments.paymentIntentId), isNotNull(payments.chargeId)), since(payments.id))).orderBy(desc(payments.id)).limit(2);
    const cards = await tx.select({ id: paymentMethods.processorId }).from(paymentMethods)
      .where(since(paymentMethods.id)).orderBy(desc(paymentMethods.id)).limit(1);
    const paths = [...customers.map((row) => '/v1/customers/' + row.id), ...attempts.map((row) => '/v1/customers/' + row.id),
      ...paid.map((row) => row.intent ? '/v1/payment_intents/' + row.intent : '/v1/charges/' + row.charge),
      ...cards.map((row) => '/v1/payment_methods/' + row.id)];
    return paths.length ? { paths: [...new Set(paths)], customersOnly: !attempts.length && !paid.length && !cards.length } : null;
  }
  /** Imported customer IDs alone, with no Stripe settings yet, tie the gym to no account (any key is accepted). */
  const importedOnly = (config: StripeConfig | null, reference: { customersOnly: boolean } | null) => config === null && reference?.customersOnly === true;
  /**
   * Open card-setup Checkout sessions: the latest one started from each card or onboarding link that can still be used.
   * (A session from before an earlier switch was expired then; expiring it again changes nothing.)
   */
  async function openSetups(tx: Transaction): Promise<string[]> {
    const starts = await tx.select({ linkId: auditEvents.targetId, after: auditEvents.after }).from(auditEvents)
      .innerJoin(signedLinks, eq(signedLinks.id, auditEvents.targetId)).where(and(eq(auditEvents.targetType, 'signed_link'),
        eq(auditEvents.action, 'billing.card_setup.started'), inArray(signedLinks.purpose, ['update_card', 'onboarding']),
        isNull(signedLinks.usedAt), isNull(signedLinks.revokedAt), gt(signedLinks.expiresAt, clock.now())))
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id));
    const latest = new Map<string, string>();
    for (const { linkId, after } of starts) {
      const sessionId = (after as { sessionId?: unknown } | null)?.sessionId;
      if (!latest.has(linkId) && typeof sessionId === 'string') latest.set(linkId, sessionId);
    }
    return [...latest.values()];
  }
  /**
   * The Stripe references the gym's test key made, which are the ones a switch to live clears: household customers the
   * app linked (created by the customers service, or matched by email for a link campaign, each audit naming the
   * customer) and cards saved through Stripe. An import writes Stripe IDs without asking Stripe, so they may be live
   * ones from the gym's own account: they stay, with the cards imported for them, and a customer the live account can't
   * read is replaced the first time it is needed (`readableCustomer`). A card on a household whose customer is cleared
   * is revoked whatever its source, since it belongs to that customer.
   */
  async function testReferences(tx: Transaction, linked: { id: string; customerId: string | null }[]) {
    const links = await tx.select({ householdId: auditEvents.targetId, after: auditEvents.after }).from(auditEvents)
      .where(and(eq(auditEvents.targetType, 'household'), inArray(auditEvents.action, ['billing.customer.linked', 'link_campaign.customer_matched'])));
    const made = new Set(links.flatMap(({ householdId, after }) => {
      const customerId = (after as { customerId?: unknown } | null)?.customerId;
      return typeof customerId === 'string' ? [householdId + ':' + customerId] : [];
    }));
    const customers = linked.filter((household) => made.has(household.id + ':' + household.customerId));
    const cleared = new Set(customers.map((household) => household.id));
    const imported = new Set((await tx.select({ id: auditEvents.targetId }).from(auditEvents)
      .where(and(eq(auditEvents.targetType, 'payment_method'), eq(auditEvents.action, 'payment_method.created')))).map((row) => row.id));
    const cards = await tx.select({ id: paymentMethods.id, householdId: paymentMethods.householdId }).from(paymentMethods)
      .where(isNull(paymentMethods.revokedAt));
    const revoked = cards.filter((card) => !imported.has(card.id) || cleared.has(card.householdId)).map((card) => card.id);
    return { customers, keptCustomers: linked.length - customers.length, cards: revoked, keptCards: cards.length - revoked.length };
  }
  /** Card payments a switch would mark as test: recorded through Stripe since the last switch, never marked. */
  const unmarkedCardPayments = (boundary: string | null) => and(eq(payments.method, 'card'), isNull(payments.reference),
    or(isNotNull(payments.paymentIntentId), isNotNull(payments.chargeId)), boundary ? gt(payments.id, boundary) : undefined);
  /** What a switch from test to live would clear now, the imported references it keeps, and the card payments it would mark as test. */
  async function testData(tx: Transaction, gymId: string): Promise<StripeTestData> {
    const boundary = await testBoundary(tx, gymId);
    const references = await testReferences(tx, await tx.select({ id: households.id, customerId: households.stripeCustomerId })
      .from(households).where(isNotNull(households.stripeCustomerId)));
    const [[checkouts], [paid], setups] = [
      await tx.select({ n: count() }).from(invoices).where(and(isNotNull(invoices.checkoutSessionId), inArray(invoices.status, payableStatuses))),
      await tx.select({ n: count() }).from(payments).where(unmarkedCardPayments(boundary)),
      await openSetups(tx)];
    return { customers: references.customers.length, cards: references.cards.length, checkouts: checkouts!.n + setups.length, payments: paid!.n,
      importedCustomers: references.keptCustomers, importedCards: references.keptCards };
  }
  /** The switch waits while a charge or refund is in flight: its outcome would be recorded against the cleared references. */
  async function assertSettled(tx: Transaction) {
    const [inFlight] = [...await tx.select({ id: paymentAttempts.id }).from(paymentAttempts).where(eq(paymentAttempts.status, 'pending')).limit(1),
      ...await tx.select({ id: refunds.id }).from(refunds).where(eq(refunds.status, 'pending')).limit(1)];
    if (inFlight) throw new AppError('conflict', 'A card payment or refund is still being processed. A refund reservation that never reached Stripe clears automatically after 23 hours, within the next hourly check. If still blocked after 24 hours, ask an owner or admin to check Stripe and payment reconciliation.',
      { restrictedKey: ['payments_in_progress'] });
  }
  /**
   * The switch from test to live, inside the save's transaction once the live key has connected: clears the Stripe
   * customer IDs the test key made (`testReferences`; each audited as unlinked, so a customer creation or card setup
   * reserved for the old ID no longer counts), revokes the cards it saved, drops the invoices' Checkout sessions and
   * reservations, closes action-needed attempts (their PaymentIntents can't be cancelled with a live key) and marks the
   * card payments as test. Imported customer IDs and cards, test payments, refunds, attempts and invoices stay. Returns
   * the Stripe objects to retire with the old test key afterwards.
   */
  async function clearTestData(tx: Transaction, gymId: string, userId: string) {
    // The charge runner reserves an attempt under its invoice's lock: holding every payable invoice first means no attempt
    // is reserved with a test card while the switch runs, and any reserved before is seen as in flight.
    const payable = await tx.select({ id: invoices.id, sessionId: invoices.checkoutSessionId, reservedUntil: invoices.checkoutExpiresAt })
      .from(invoices).where(inArray(invoices.status, payableStatuses)).for('update');
    await assertSettled(tx);
    const boundary = await testBoundary(tx, gymId), now = clock.now();
    const setups = await openSetups(tx);
    const references = await testReferences(tx, await tx.select({ id: households.id, customerId: households.stripeCustomerId })
      .from(households).where(isNotNull(households.stripeCustomerId)).for('update'));
    const linked = references.customers;
    // A household without a customer may have a creation in flight with the test key: a new generation keeps it unlinked.
    const reserved = (await tx.selectDistinct({ id: auditEvents.targetId }).from(auditEvents)
      .where(and(eq(auditEvents.action, 'billing.customer.creation_reserved'), eq(auditEvents.targetType, 'household')))).map((row) => row.id);
    const pending: { id: string; customerId: string | null }[] = [];
    for (let index = 0; index < reserved.length; index += 500)
      pending.push(...await tx.select({ id: households.id, customerId: households.stripeCustomerId }).from(households)
        .where(and(inArray(households.id, reserved.slice(index, index + 500)), isNull(households.stripeCustomerId))).for('update'));
    const unlinked = [...linked, ...pending];
    for (let index = 0; index < unlinked.length; index += 500) {
      const chunk = unlinked.slice(index, index + 500);
      await tx.update(households).set({ stripeCustomerId: null }).where(inArray(households.id, chunk.map((row) => row.id)));
      await tx.insert(auditEvents).values(chunk.map((row) => ({ gymId, actorKind: 'user', actorUserId: userId,
        action: customerUnlinkedAction, targetType: 'household', targetId: row.id, before: { customerId: row.customerId },
        after: { customerId: null, reason: 'stripe_test_cleared' }, occurredAt: now })));
    }
    const cards: { id: string }[] = [];
    for (let index = 0; index < references.cards.length; index += 500)
      cards.push(...await tx.update(paymentMethods).set({ revokedAt: now, isDefault: false })
        .where(and(inArray(paymentMethods.id, references.cards.slice(index, index + 500)), isNull(paymentMethods.revokedAt)))
        .returning({ id: paymentMethods.id }));
    // Paid and void invoices keep their completed session's ID as history; nothing reads it with the new key.
    const sessions = payable.filter((row) => row.sessionId || row.reservedUntil);
    for (let index = 0; index < sessions.length; index += 500)
      await tx.update(invoices).set({ checkoutSessionId: null, checkoutExpiresAt: null })
        .where(inArray(invoices.id, sessions.slice(index, index + 500).map((row) => row.id)));
    const actionNeeded = await tx.update(paymentAttempts).set({ status: 'failed' })
      .where(and(eq(paymentAttempts.status, 'requires_action'), boundary ? gt(paymentAttempts.id, boundary) : undefined))
      .returning({ id: paymentAttempts.id, intentId: paymentAttempts.paymentIntentId });
    // The open disputes of the payments marked below are in the test account too: the live key can't read or answer
    // them, so they close here (a dispute's final status never reopens). The dispute writer waits for the gym row, so
    // none is attached to these invoices while the switch runs.
    const disputed = await tx.select({ id: invoices.id, disputeId: invoices.disputeId, disputeStatus: invoices.disputeStatus }).from(invoices)
      .where(and(inArray(invoices.id, tx.select({ id: payments.invoiceId }).from(payments).where(unmarkedCardPayments(boundary))),
        isNotNull(invoices.disputeId), or(isNull(invoices.disputeStatus), notInArray(invoices.disputeStatus, [...terminalDisputeStatuses]))))
      .for('update');
    if (disputed.length) {
      await tx.update(invoices).set({ disputeStatus: closedTestDispute }).where(inArray(invoices.id, disputed.map((row) => row.id)));
      await tx.insert(auditEvents).values(disputed.map((row) => ({ gymId, actorKind: 'user', actorUserId: userId,
        action: 'billing.invoice.disputed', targetType: 'invoice', targetId: row.id,
        before: { disputeId: row.disputeId, disputeStatus: row.disputeStatus },
        after: { disputeId: row.disputeId, disputeStatus: closedTestDispute, reason: 'stripe_test_cleared' }, occurredAt: now })));
    }
    const marked = await tx.update(payments).set({ reference: stripeTestPaymentReference }).where(unmarkedCardPayments(boundary))
      .returning({ id: payments.id });
    const checkouts = [...sessions.flatMap((row) => row.sessionId ? [row.sessionId] : []), ...setups];
    const cleared = { customers: linked.length, cards: cards.length, checkouts: checkouts.length, actionNeeded: actionNeeded.length,
      payments: marked.length, disputes: disputed.length };
    await writeAudit(tx, { gymId, actorKind: 'user', actorUserId: userId, action: testClearedAction, targetType: 'gym', targetId: gymId,
      before: null, after: { ...cleared, keptImportedCustomers: references.keptCustomers, keptImportedCards: references.keptCards,
        reservations: sessions.length, abandonedCreations: pending.length, paymentIds: marked.map((row) => row.id),
        disputedInvoiceIds: disputed.map((row) => row.id) }, occurredAt: now });
    return { checkouts, intents: actionNeeded.flatMap((row) => row.intentId ? [row.intentId] : []) };
  }
  /**
   * After the switch is saved: expires the test Checkout sessions it dropped and cancels the action-needed PaymentIntents,
   * with the old test key, so none of them can complete. Test objects only; a failure is logged, never raised (the old
   * webhook endpoint is retired too, so nothing they did would reach the gym).
   */
  async function retireTestObjects(gymId: string, previous: StripeConfig, objects: { checkouts: string[]; intents: string[] }) {
    const provider = new StripePayments(gymId, { transport: transportFor(previous.apiKey), webhookSecret: previous.webhookSecret, mode: previous.mode });
    const work = [...objects.checkouts.map((id) => async () => {
      const expiry = await provider.expireCheckout(id);
      if (expiry.status !== 'expired') logError('settings.stripe_test_checkout_not_expired', { gymId, status: expiry.status });
    }), ...objects.intents.map((id) => async () => {
      const outcome = await provider.cancelCharge(id);
      if (outcome.status !== 'failed' && outcome.status !== 'succeeded')
        logError('settings.stripe_test_intent_not_cancelled', { gymId, status: outcome.status });
    })];
    const all = (async () => {
      for (let index = 0; index < work.length; index += 4)
        await Promise.all(work.slice(index, index + 4).map(async (step) => {
          try { await step(); } catch (error) { logError('settings.stripe_test_object_retire_failed', { gymId }, error); }
        }));
    })();
    // A gym with many open test sessions doesn't hold the owner's request (the switch is already saved): the rest carry on.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([all, new Promise<void>((resolve) => { timer = setTimeout(resolve, retireBudgetMs); })]);
    clearTimeout(timer);
  }
  function backups(gym: Gym): BackupsIntegration | null {
    if (!single || sandbox) return null;
    const destination = storedDestinationSchema.safeParse(gym.backupDestination);
    const pending = pendingBackup(gym);
    return { configured: Boolean(gym.backupPublicKey && gym.backupBlobKey && gym.s3Config && gym.backupDestination),
      destination: destination.success ? destination.data : null, publicKey: gym.backupPublicKey,
      pending: pending ? { destination: pending.destination, publicKey: pending.publicKey } : null,
      retentionBudgetBytes: Number(gym.backupRetentionBytes ?? defaultRetentionBytes) };
  }
  async function present(gymId: string, userId: string): Promise<Integrations> {
    const { gym, config, reference, test } = await scope(gymId, async (tx) => {
      const [row] = await readGym(tx, gymId);
      if (!row) throw new AppError('not_found', 'Gym not found');
      const stored = readStripeConfig(options.key, row.stripeConfig, gymId), found = await stripeReference(tx, gymId);
      return { gym: row, config: stored, reference: found,
        test: stored?.mode === 'test' && found !== null && !sandbox ? await testData(tx, gymId) : null };
    });
    const imported = importedOnly(config, reference);
    return { email: await email(gym, userId),
      payments: { configured: config !== null, mode: config?.mode ?? null, webhookRegistered: Boolean(config?.endpointId),
        accountLocked: reference !== null && !imported, testData: test, importedCustomersOnly: imported },
      backups: backups(gym), sandbox, integrationsEditable, revision: gym.revision };
  }
  const userOf = (context: MutationContext) => {
    if (context.actor.kind !== 'user') throw new AppError('forbidden', 'Owner access required');
    return context.actor.userId;
  };
  function assertChangeable() {
    if (sandbox) throw new AppError('forbidden', 'A sandbox uses the demo’s own email and payments');
    if (!integrationsEditable) throw new AppError('forbidden', 'This install’s operator manages email and payments', { integrations: ['operator_managed'] });
  }
  function assertBackups() {
    if (!single || sandbox) throw new AppError('not_found', 'Backups are not available on this install');
  }
  /** A gym stores its own Google client only on a single-gym install whose configuration doesn't set one. */
  function assertGoogle() {
    if (!google.editable || sandbox) {
      if (google.install) throw new AppError('conflict', 'This install’s configuration sets Google sign-in', { google: ['install_configured'] });
      throw new AppError('not_found', 'Google sign-in settings are not available on this install');
    }
  }
  /** What a Google change records: where the client comes from, never its ID or secret. */
  const googleAudit = (gym: Gym) => ({ source: google.install ? 'install' : gym.googleConfig ? 'gym' : 'none' });
  async function googleLogin(gym: Gym, userId: string): Promise<GoogleLogin> {
    const editable = google.editable && !sandbox;
    const stored = editable ? readGoogleConfig(options.key, gym.googleConfig, gym.id) : null;
    const source = google.install ? 'install' : stored ? 'gym' : 'none';
    // Removing the stored client leaves email links (the gym's SMTP or the install's) and the owner's own password.
    const after = signIn(Boolean(gym.smtpConfig) || installSmtp);
    const removeBlocked = source === 'gym' && !after.magicLink && !(after.password && await options.hasPassword(userId));
    return { source, editable, unreadable: editable && Boolean(gym.googleConfig) && !stored, clientId: stored?.clientId ?? null,
      clientSecretSet: source === 'gym', removeBlocked, revision: gym.revision };
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

    /** Google sign-in for the signed-in owner (their own password decides whether the stored client can be removed). */
    async getGoogle(gymId: string, userId: string): Promise<GoogleLogin> { return googleLogin(await gymRow(gymId), userId); },

    /**
     * Stores the gym's own Google OAuth client, replacing any stored one; the next sign-in uses it. Single-gym installs
     * only, and refused when the install's configuration sets Google. Neither value is audited or logged.
     */
    async saveGoogle(context: MutationContext, input: SaveGoogleLoginRequest): Promise<GoogleLogin> {
      assertGoogle();
      const userId = userOf(context);
      const value = encryptGoogleConfig(options.key, context.gymId, { clientId: input.clientId, clientSecret: input.clientSecret });
      const after = await save(context, input.revision, async (gym) => ({ set: { googleConfig: value },
        action: 'integrations.google_saved', before: googleAudit(gym), after: googleAudit }));
      return googleLogin(after, userId);
    },

    /** Turns Google sign-in off for the gym. Refused while it would leave the signed-in owner no way to sign in. */
    async removeGoogle(context: MutationContext, input: RemoveGoogleLoginRequest): Promise<GoogleLogin> {
      assertGoogle();
      const userId = userOf(context);
      const gym = await assertCurrent(context.gymId, input.revision);
      const notConfigured = () => new AppError('conflict', 'The gym has no Google client of its own', { google: ['not_configured'] });
      if (!gym.googleConfig) throw notConfigured();
      if ((await googleLogin(gym, userId)).removeBlocked)
        throw new AppError('conflict', 'Google is your only way to sign in: set up email or a password first', { google: ['only_sign_in'] });
      const after = await save(context, input.revision, async (before) => {
        if (!before.googleConfig) throw notConfigured();
        return { set: { googleConfig: null }, action: 'integrations.google_removed', before: googleAudit(before), after: googleAudit };
      });
      return googleLogin(after, userId);
    },

    /** Sends a test message through the submitted settings and saves them only if it is accepted. */
    async saveEmail(context: MutationContext, input: SaveEmailIntegrationRequest): Promise<{ test: 'sent' | 'failed'; integrations: Integrations }> {
      assertChangeable();
      const userId = userOf(context);
      // On a multi-gym install the test connection is made for a tenant: only SMTP ports and public addresses, so it
      // can't probe other services or the operator's network. A refused host is simply a failed test, like a name that
      // doesn't resolve, so the answer says nothing about which internal names exist.
      if (!single && !smtpPorts.includes(input.port))
        throw new AppError('invalid_request', 'Use an SMTP port: ' + smtpPorts.join(', '), { port: ['port_not_allowed'] });
      await assertCurrent(context.gymId, input.revision);
      const stored = storedSmtpFromRequest(input);
      if (!await sendSmtpTest(stored, setupTestMessage(input.testTo), options.sendTest, !single))
        return { test: 'failed', integrations: await present(context.gymId, userId) };
      await save(context, input.revision, async (gym) => ({ set: { smtpConfig: encryptSmtpConfig(options.key, context.gymId, stored) },
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
     * Stripe customers, cards or card payments, the new key must be in the same mode and read at least one of them, with
     * two exceptions: a switch from test to live confirmed with `clearTestData` clears the test-mode references once the
     * live key connects (see `clearTestData`), and imported customer IDs alone, before any Stripe settings, are not checked.
     */
    async saveStripe(context: MutationContext, input: SaveStripeIntegrationRequest): Promise<Integrations> {
      assertChangeable();
      const userId = userOf(context), gymId = context.gymId;
      const mode = restrictedKeyMode(input.restrictedKey);
      const { gym, previous, reference, switching } = await scope(gymId, async (tx) => {
        const [row] = await readGym(tx, gymId);
        if (!row) throw new AppError('not_found', 'Gym not found');
        const stored = readStripeConfig(options.key, row.stripeConfig, gymId);
        // Only test to live: the test references are cleared, so the live key needn't read them. Live to test stays refused.
        const clearing = input.clearTestData && stored?.mode === 'test' && mode === 'live';
        // Checked again by the switch; here, before any endpoint is registered.
        if (clearing && row.revision === input.revision) await assertSettled(tx);
        return { gym: row, previous: stored, reference: await stripeReference(tx, gymId), switching: clearing };
      });
      assertRevised(gym.revision === input.revision ? [gym] : []);
      if (reference && previous && previous.mode !== mode && !switching)
        throw new AppError('conflict', 'Stripe customers and payments exist in ' + previous.mode + ' mode', { restrictedKey: ['mode_locked'] });
      const checked = reference && !switching && !importedOnly(previous, reference) ? reference : null;
      const origin = await options.origin(gymId);
      let connected: { config: StripeConfig; reused: boolean };
      try {
        // After the permission probe, so a key missing a permission is told which one; before any endpoint is registered.
        connected = await stripe.connect(gymId, origin, input.revision, input.restrictedKey, previous, async () => {
          if (checked && !await sameAccount(input.restrictedKey, checked))
            throw new AppError('conflict', 'The key belongs to another Stripe account', { restrictedKey: ['account_locked'] });
        });
      } catch (error) { throw stripeFailure(gymId, error); }
      const { config, reused } = connected;
      // Assigned inside the save's transaction; the cast keeps TypeScript from narrowing it to null here.
      let retire = null as { checkouts: string[]; intents: string[] } | null;
      // A failed save leaves an unreferenced endpoint, never active credentials; the next successful save retires it.
      await save(context, input.revision, async (before, tx) => {
        // A card or payment recorded while Stripe was called would need the account check, which ran without one.
        const now = await stripeReference(tx, gymId);
        if (!checked && !switching && now !== null && !importedOnly(previous, now))
          throw new AppError('conflict', 'Stripe customers were recorded while the key was checked; try again');
        if (switching) retire = await clearTestData(tx, gymId, userId);
        const was = readStripeConfig(options.key, before.stripeConfig, gymId);
        return { set: { stripeConfig: encryptSecret(options.key, { secretClass: 'stripe_config', owner: gymId }, JSON.stringify(config)) }, action: 'integrations.stripe_saved',
          before: { mode: was?.mode ?? null, endpointId: was?.endpointId ?? null },
          after: () => ({ mode: config.mode, endpointId: config.endpointId, endpointReused: reused, testDataCleared: switching }) };
      });
      await stripe.retireStale(gymId, origin, previous, config, reused);
      if (retire && previous) await retireTestObjects(gymId, previous, retire);
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
      await requireBackupDestination(input.destination, context.gymId, options.checkDestination);
      const { privateKey, publicKey } = await backupKeyPair();
      const { destination, s3Config } = backupColumns(options.key, context.gymId, input.destination);
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
        // Restore and key rotation re-encrypt the pending credentials too. Check they still open before activating
        // them, stored afresh in their column; corrupt or unreadable pending credentials require a new backup key.
        const s3 = { secretClass: 's3_config', owner: context.gymId } as const;
        let s3Config: string;
        try { s3Config = encryptSecret(options.key, s3, decryptSecret(options.key, s3, pending.s3Config)); }
        catch { throw new AppError('conflict', 'Generate a new backup key first', { privateKey: ['no_pending_key'] }); }
        const settings = gym.settings as { integrations?: Record<string, unknown> };
        const integrations = { ...settings.integrations };
        delete integrations.backup;
        return { set: { backupDestination: pending.destination, s3Config,
          backupPublicKey: publicKey, backupBlobKey: gym.backupBlobKey ?? newBlobKey(options.key, context.gymId),
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
