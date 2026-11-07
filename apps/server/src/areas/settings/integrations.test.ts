// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, households, invoices, paymentAttempts, paymentMethods, payments, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { createBackupKeyResponseSchema, integrationsResponseSchema, saveEmailIntegrationResponseSchema, stripeTestPaymentReference } from '@plaingym/shared/contracts';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler } from '../../core/errors.js';
import { authorize } from '../staff/auth.permissions.js';
import type { RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';
import { setLogSink } from '../../core/log.js';
import { authConfig } from '../../infra/auth/config.js';
import { StripeFixtures } from '../../infra/payments/stripe-fixtures.js';
import { StripePayments } from '../../infra/payments/stripe.js';
import { stripeProvisioner } from '../../infra/payments/setup.js';
import type { StripeConfig } from '../setup/stripe-step.js';
import { createIntegrationsService, type IntegrationsOptions } from './integrations.js';
import { createIntegrationsRoutes } from './integrations.routes.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-11-02T12:00:00Z');
const key = Buffer.alloc(32, 7), origin = 'https://gym.invalid';
const env = { AUTH_SECRET: 'integration-settings-secret-with-32-characters', TENANCY: 'single', AUTH_PASSWORD_LOGIN: 'auto' };
const installEnv = { ...env, SMTP_HOST: 'smtp.install.invalid', SMTP_FROM: 'install@example.test' };
const smtpPassword = 'smtp-password-never-shown', storageSecret = 'storage-secret-never-shown', storageKeyId = 'storage-id-never-shown';
const sendTest = vi.fn(async () => { assertNoTransaction('integrations SMTP test'); });
const withPassword = new Set<string>();
const hasPassword = vi.fn(async (userId: string) => withPassword.has(userId));
const requestSnapshot = vi.fn(async (_change: string) => { assertNoTransaction('integrations snapshot request'); });
const checkDestination = vi.fn(async (_destination: unknown) => { assertNoTransaction('integrations destination check'); });
/** A live key's account: Stripe marks its objects `livemode`. */
class LiveFixtures extends StripeFixtures {
  override async request(input: Parameters<StripeFixtures['request']>[0]) {
    const result = await super.request(input), stored = typeof result.id === 'string' ? this.objects.get(result.id) : undefined;
    if (stored) stored.livemode = true;
    return 'livemode' in result ? { ...result, livemode: true } : result;
  }
}
/** One synthetic Stripe account per key, unless a test points a key at an existing account. */
const accounts = new Map<string, StripeFixtures>();
const account = (apiKey: string) => {
  if (!accounts.has(apiKey)) accounts.set(apiKey, new (apiKey.startsWith('rk_live_') ? LiveFixtures : StripeFixtures)('provisioning', undefined, (accounts.size + 1) * 1000));
  return accounts.get(apiKey)!;
};
const base: IntegrationsOptions = { key, env, config: authConfig(env, false), origin: async () => origin, hasPassword, clock, requestSnapshot, checkDestination,
  scope: database.forGym, sendTest, provisioner: (apiKey) => stripeProvisioner(account(apiKey), apiKey.startsWith('rk_live_') ? 'live' : 'test'),
  transport: (apiKey) => account(apiKey) };
const service = createIntegrationsService(base);
const gymA = uuidv7(), gymB = uuidv7();
let owner: string, ownerB: string;
/** Every response body and audit row the tests saw, checked for credentials at the end. */
const seen: string[] = [];
beforeAll(async () => {
  await factory('gyms', gymA, { name: 'Gym A' });
  await factory('gyms', gymB, { name: 'Gym B' });
  owner = (await factory('authUser', gymA)).id;
  ownerB = (await factory('authUser', gymB)).id;
});
beforeEach(() => { sendTest.mockClear(); });

function server(options: { role?: StaffRole; gymId?: string; principalGym?: string; userId?: string; routesService?: ReturnType<typeof createIntegrationsService> } = {}) {
  const { role = 'owner', gymId = gymA, principalGym = gymId, userId = gymId === gymB ? ownerB : owner } = options;
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() },
      principal: { kind: 'staff', gymId: principalGym, userId, roles: [role] }, clock, requestId: 'test' }); await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes: createIntegrationsRoutes(options.routesService ?? service) }).mount(app, authorize, new Set());
  return app;
}
async function call(app: ReturnType<typeof server>, method: string, path: string, body?: unknown) {
  const response = await app.request('/api/settings/integrations' + path, { method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const text = await response.text();
  seen.push(text);
  return { status: response.status, json: text ? JSON.parse(text) as { data: never; error?: { details?: Record<string, string[]> } } : null };
}
const read = async (app = server()) => integrationsResponseSchema.parse((await call(app, 'GET', '')).json).data;
const row = async (gymId = gymA) => (await database.forGym(gymId, (tx) => tx.select().from(gyms)))[0]!;
const stripeOf = async (gymId = gymA) => { const gym = await row(gymId); return gym.stripeConfig ? JSON.parse(decryptSecret(key, { secretClass: 'stripe_config', owner: gymId }, gym.stripeConfig)) as StripeConfig : null; };
const email = (revision: number, overrides: Record<string, unknown> = {}) => ({ revision, host: 'smtp.gym.invalid', port: 465, secure: true,
  username: 'gym-user', password: smtpPassword, from: 'desk@gym.invalid', testTo: 'owner@gym.invalid', ...overrides });
const destination = (bucket: string) => ({ endpoint: 'https://s3.example.test', region: 'auto', bucket, accessKeyId: storageKeyId, secretAccessKey: storageSecret });

describe('integration settings permissions', () => {
  it.each(staffRoles)('lets only owners read and change integrations (%s)', async (role) => {
    const app = server({ role }), allowed = role === 'owner';
    expect((await call(app, 'GET', '')).status).toBe(allowed ? 200 : 403);
    for (const [method, path] of [['PUT', '/email'], ['DELETE', '/email'], ['PUT', '/stripe'], ['POST', '/backups'], ['POST', '/backups/confirm']] as const)
      expect((await call(app, method, path, {})).status, method + ' ' + path).toBe(allowed ? 400 : 403);
    expect(sendTest).not.toHaveBeenCalled();
  });
  it('denies an owner of another gym and leaves that gym untouched', async () => {
    const app = server({ gymId: gymB, principalGym: gymA, userId: owner }), before = await row(gymB);
    expect((await call(app, 'GET', '')).status).toBe(403);
    expect((await call(app, 'PUT', '/email', email(before.revision))).status).toBe(403);
    expect((await call(app, 'PUT', '/stripe', { revision: before.revision, restrictedKey: 'rk_test_crossgym' })).status).toBe(403);
    expect((await call(app, 'POST', '/backups', { revision: before.revision, destination: destination('cross') })).status).toBe(403);
    expect(sendTest).not.toHaveBeenCalled();
    expect(await row(gymB)).toEqual(before);
  });
});

describe('Settings → Email', () => {
  it('saves only after the test message is accepted, and shows the change of sign-in method', async () => {
    const before = await read();
    expect(before.email).toMatchObject({ source: 'none', host: null, signIn: { password: true, magicLink: false },
      signInAfterSave: { password: false, magicLink: true }, signInAfterRemove: null, removeBlocked: false });
    sendTest.mockRejectedValueOnce(new Error('550 rejected ' + smtpPassword));
    const failed = await call(server(), 'PUT', '/email', email(before.revision));
    expect(failed.status).toBe(200);
    expect(saveEmailIntegrationResponseSchema.parse(failed.json).data).toMatchObject({ test: 'failed', integrations: { revision: before.revision, email: { source: 'none' } } });
    expect((await row()).smtpConfig).toBeNull();

    const saved = saveEmailIntegrationResponseSchema.parse((await call(server(), 'PUT', '/email', email(before.revision))).json).data;
    expect(sendTest).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'smtp.gym.invalid', port: 465, security: 'tls' }),
      expect.objectContaining({ to: 'owner@gym.invalid' }));
    expect(saved).toMatchObject({ test: 'sent', integrations: { revision: before.revision + 1, email: { source: 'gym', host: 'smtp.gym.invalid',
      port: 465, security: 'tls', from: 'desk@gym.invalid', signIn: { password: false, magicLink: true }, signInAfterRemove: { password: true, magicLink: false } } } });
    expect(JSON.parse(decryptSecret(key, { secretClass: 'smtp_config', owner: gymA }, (await row()).smtpConfig!))).toMatchObject({ username: 'gym-user', password: smtpPassword });
    const [audit] = await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'integrations.email_saved')));
    expect(audit).toMatchObject({ actorUserId: owner, before: { source: 'none' }, after: { source: 'gym', host: 'smtp.gym.invalid', revision: before.revision + 1 } });
  });
  it('refuses a stale revision before sending anything', async () => {
    const { revision } = await read();
    expect((await call(server(), 'PUT', '/email', email(revision - 1))).status).toBe(409);
    expect(sendTest).not.toHaveBeenCalled();
  });
  it('refuses to remove email while it is the owner’s only way to sign in, then removes it once they have a password', async () => {
    const current = await read();
    expect(current.email).toMatchObject({ source: 'gym', removeBlocked: true });
    const refused = await call(server(), 'DELETE', '/email', { revision: current.revision });
    expect(refused.status).toBe(409);
    expect(refused.json?.error?.details).toEqual({ email: ['only_sign_in'] });
    expect((await row()).smtpConfig).not.toBeNull();
    withPassword.add(owner);
    expect((await read()).email.removeBlocked).toBe(false);
    const removed = integrationsResponseSchema.parse((await call(server(), 'DELETE', '/email', { revision: current.revision })).json).data;
    expect(removed).toMatchObject({ revision: current.revision + 1, email: { source: 'none', host: null, signIn: { password: true, magicLink: false } } });
    expect((await row()).smtpConfig).toBeNull();
    expect((await call(server(), 'DELETE', '/email', { revision: removed.revision })).json?.error?.details).toEqual({ email: ['not_configured'] });
    withPassword.delete(owner);
  });
  it('falls back to the install’s SMTP, so removal never locks anyone out there', async () => {
    const install = createIntegrationsService({ ...base, env: installEnv, config: authConfig(installEnv) });
    const app = server({ routesService: install }), { revision } = await read(app);
    await call(app, 'PUT', '/email', email(revision));
    hasPassword.mockClear();
    const saved = await read(app);
    expect(saved.email).toMatchObject({ source: 'gym', signInAfterRemove: { password: false, magicLink: true }, removeBlocked: false });
    expect(hasPassword).not.toHaveBeenCalled();
    const removed = integrationsResponseSchema.parse((await call(app, 'DELETE', '/email', { revision: saved.revision })).json).data;
    expect(removed.email).toMatchObject({ source: 'install', host: null, signIn: { password: false, magicLink: true } });
  });
});

describe('Settings → Payments', () => {
  const save = async (restrictedKey: string) => call(server(), 'PUT', '/stripe', { revision: (await read()).revision, restrictedKey });
  it('connects a key through the setup probe and webhook lifecycle, and accepts another account while nothing belongs to the first', async () => {
    const first = await save('rk_test_first');
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(integrationsResponseSchema.parse(first.json).data.payments).toEqual({ configured: true, mode: 'test', webhookRegistered: true, accountLocked: false,
      testData: null, importedCustomersOnly: false });
    const firstConfig = (await stripeOf())!;
    expect(firstConfig).toMatchObject({ apiKey: 'rk_test_first', mode: 'test' });
    expect(account('rk_test_first').objects.get(firstConfig.endpointId)).toMatchObject({ url: origin + '/webhooks/stripe', metadata: { gym_id: gymA } });
    const other = await save('rk_test_other');
    expect(other.status).toBe(200);
    expect(await stripeOf()).toMatchObject({ apiKey: 'rk_test_other' });
    // The old account's endpoint is removed once the new settings are saved.
    expect(account('rk_test_first').objects.has(firstConfig.endpointId)).toBe(false);
    const [audit] = await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'integrations.stripe_saved')));
    expect(audit).toMatchObject({ actorUserId: owner, before: { mode: null }, after: { mode: 'test', endpointReused: false } });
  });
  it('names a missing permission and refuses a malformed key without saving anything', async () => {
    const before = await row();
    const limited = account('rk_test_limited');
    const request = limited.request.bind(limited);
    accounts.set('rk_test_limited', Object.assign(Object.create(limited) as StripeFixtures, {
      request: async (input: Parameters<StripeFixtures['request']>[0]) => {
        if (input.path === '/v1/disputes') throw Object.assign(new Error('Forbidden'), { type: 'StripePermissionError', statusCode: 403 });
        return request(input);
      } }));
    const refused = await save('rk_test_limited');
    expect(refused.status).toBe(400);
    expect(refused.json?.error?.details).toEqual({ restrictedKey: ['missing_permission'] });
    expect((await save('sk_test_secret')).status).toBe(400);
    expect(await row()).toEqual(before);
  });
  it('refuses a key for another account, or the other mode, once a household has a Stripe customer', async () => {
    const current = account('rk_test_other');
    const customer = await current.request({ method: 'POST', path: '/v1/customers', params: { email: 'payer@example.test' } });
    await factory('households', gymA, { stripeCustomerId: String(customer.id) });
    expect((await read()).payments.accountLocked).toBe(true);
    // Row-level security: gym A's customer never locks gym B, and gym B sees none of gym A's settings.
    expect((await read(server({ gymId: gymB }))).payments).toEqual({ configured: false, mode: null, webhookRegistered: false, accountLocked: false,
      testData: null, importedCustomersOnly: false });
    // Written straight to the household, as an import does: kept by a switch, since it may be a live customer.
    expect((await read()).payments.testData).toEqual({ customers: 0, cards: 0, checkouts: 0, payments: 0, importedCustomers: 1, importedCards: 0 });
    const before = await row();
    const foreign = await save('rk_test_foreign');
    expect(foreign.status).toBe(409);
    expect(foreign.json?.error?.details).toEqual({ restrictedKey: ['account_locked'] });
    const live = await save('rk_live_switch');
    expect(live.status).toBe(409);
    expect(live.json?.error?.details).toEqual({ restrictedKey: ['mode_locked'] });
    // The permission probe runs first, so a key missing one is told which, even while the account is locked.
    const limited = account('rk_test_limited2'), request = limited.request.bind(limited);
    accounts.set('rk_test_limited2', Object.assign(Object.create(limited) as StripeFixtures, {
      request: async (input: Parameters<StripeFixtures['request']>[0]) => {
        if (input.path === '/v1/disputes') throw Object.assign(new Error('Forbidden'), { type: 'StripePermissionError', statusCode: 403 });
        return request(input);
      } }));
    expect((await save('rk_test_limited2')).json?.error?.details).toEqual({ restrictedKey: ['missing_permission'] });
    expect(await row()).toEqual(before);
    // A second restricted key for the same account is accepted, and keeps the webhook endpoint (and its signing secret),
    // even when the newest household holds a customer ID the account doesn't have (an import typo, say).
    await factory('households', gymA, { stripeCustomerId: 'cus_ImportTypo' });
    accounts.set('rk_test_rotated', current);
    const kept = (await stripeOf())!;
    expect((await save('rk_test_rotated')).status).toBe(200);
    expect(await stripeOf()).toEqual({ ...kept, apiKey: 'rk_test_rotated' });
  });
});

describe('Settings → Payments: test to live', () => {
  const gymC = uuidv7(), gymD = uuidv7();
  let ownerC: string, ownerD: string;
  beforeAll(async () => {
    await factory('gyms', gymC, { name: 'Gym C' }); await factory('gyms', gymD, { name: 'Gym D' });
    ownerC = (await factory('authUser', gymC)).id; ownerD = (await factory('authUser', gymD)).id;
  });
  const appC = () => server({ gymId: gymC, userId: ownerC }), appD = () => server({ gymId: gymD, userId: ownerD });
  const saveTo = async (app: ReturnType<typeof server>, restrictedKey: string, extra: Record<string, unknown> = {}) =>
    call(app, 'PUT', '/stripe', { revision: (await read(app)).revision, restrictedKey, ...extra });
  const audits = (gymId: string, action: string) => database.forGym(gymId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, action)));
  /** The gym's Stripe objects as the app sees them: what the switch may change. */
  const snapshot = (gymId: string) => database.forGym(gymId, async (tx) => ({
    households: await tx.select().from(households), cards: await tx.select().from(paymentMethods), invoices: await tx.select().from(invoices),
    attempts: await tx.select().from(paymentAttempts), payments: await tx.select().from(payments) }));

  it('clears exactly the test-mode references after the live key connects, in one audited change, and keeps the books', async () => {
    expect((await saveTo(appC(), 'rk_test_gymc')).status).toBe(200);
    const test = account('rk_test_gymc'), testConfig = (await stripeOf(gymC))!;
    const provider = new StripePayments(gymC, { transport: test, webhookSecret: 'whsec_fixture', mode: 'test' });
    // A household with a test customer the app created, a saved card, an open pay link and an open card setup link.
    const customer = await provider.createCustomer({ email: 'payer@example.test', name: 'Payer', householdId: uuidv7(), idempotencyKey: 'c1' });
    const payer = await factory('households', gymC, { stripeCustomerId: customer.id, email: 'payer@example.test' });
    await factory('auditEvents', gymC, { action: 'billing.customer.linked', targetType: 'household', targetId: payer.id, after: { customerId: customer.id } });
    const card = await factory('paymentMethods', gymC, { householdId: payer.id, processorId: 'pm_4242', isDefault: true });
    // A test customer matched by email for a link campaign.
    const matched = await factory('households', gymC, { stripeCustomerId: 'cus_TestMatched' });
    await factory('auditEvents', gymC, { action: 'link_campaign.customer_matched', targetType: 'household', targetId: matched.id,
      after: { matched: true, customerId: 'cus_TestMatched' } });
    // Imported references are written without asking Stripe, so they may be the gym's live ones: an imported customer and
    // its imported card stay. An imported card on the payer's household goes with the payer's test customer.
    const imported = await factory('households', gymC, { stripeCustomerId: 'cus_ImportedLive' });
    const importedCard = await factory('paymentMethods', gymC, { householdId: imported.id, processorId: 'pm_ImportedLive', isDefault: true });
    const payerImport = await factory('paymentMethods', gymC, { householdId: payer.id, processorId: 'pm_ImportedPayer' });
    for (const method of [importedCard, payerImport])
      await factory('auditEvents', gymC, { action: 'payment_method.created', targetType: 'payment_method', targetId: method.id, after: { importId: uuidv7() } });
    const checkout = (invoiceId: string) => provider.createCheckout({ mode: 'payment', customerId: customer.id, invoiceId, amount: 5000, currency: 'usd',
      successUrl: origin + '/l/return', cancelUrl: origin + '/l/return', saveForOffSession: false, idempotencyKey: 'checkout:' + invoiceId });
    const open = await factory('invoices', gymC, { householdId: payer.id, status: 'open', number: 1 });
    const payLink = await checkout(open.id);
    await database.forGym(gymC, (tx) => tx.update(invoices).set({ checkoutSessionId: payLink.id, checkoutExpiresAt: new Date('2026-11-03T00:00:00Z') }).where(eq(invoices.id, open.id)));
    const link = await factory('signedLinks', gymC, { householdId: payer.id, purpose: 'update_card', expiresAt: new Date('2026-12-01T00:00:00Z') });
    const setup = await provider.createCheckout({ mode: 'setup', customerId: customer.id, linkId: link.id, successUrl: origin + '/l/return',
      cancelUrl: origin + '/l/return', saveForOffSession: true, idempotencyKey: 'setup:' + link.id });
    await factory('auditEvents', gymC, { action: 'billing.card_setup.started', targetType: 'signed_link', targetId: link.id, after: { sessionId: setup.id } });
    // A paid invoice with its test card payment, a cash payment, and an action-needed attempt on a past-due invoice.
    // A paid invoice keeps its completed session's ID as history. Its open dispute is in the test account.
    const paid = await factory('invoices', gymC, { householdId: payer.id, status: 'paid', number: 2, checkoutSessionId: 'cs_completed',
      disputeId: 'dp_test', disputeStatus: 'needs_response' });
    const cardPayment = await factory('payments', gymC, { invoiceId: paid.id, method: 'card', paymentIntentId: 'pi_testpaid', chargeId: 'ch_testpaid' });
    const cash = await factory('payments', gymC, { invoiceId: paid.id, method: 'cash', reference: 'Receipt 12', amountCents: 100 });
    // A dispute on an invoice no test card payment paid stays open.
    const cashOnly = await factory('invoices', gymC, { householdId: payer.id, status: 'paid', number: 9, disputeId: 'dp_cash', disputeStatus: 'needs_response' });
    await factory('payments', gymC, { invoiceId: cashOnly.id, method: 'cash', reference: 'Receipt 13', amountCents: 100 });
    const pastDue = await factory('invoices', gymC, { householdId: payer.id, kind: 'one_off', status: 'past_due', number: 3 });
    const intent = await test.request({ method: 'POST', path: '/v1/payment_intents', params: { amount: 10000, currency: 'usd', customer: customer.id, metadata: { gym_id: gymC } } });
    const actionNeeded = await factory('paymentAttempts', gymC, { invoiceId: pastDue.id, status: 'requires_action', paymentIntentId: String(intent.id),
      stripeCustomerId: customer.id, savedPaymentMethod: 'pm_4242', declineCode: 'authentication_required', resolvedAt: clock.now() });
    // Another gym's Stripe references are never read or touched.
    const other = await factory('households', gymB, { stripeCustomerId: 'cus_GymB' });
    // A household whose customer creation may still be in flight with the test key.
    const creating = await factory('households', gymC);
    await factory('auditEvents', gymC, { action: 'billing.customer.creation_reserved', targetType: 'household', targetId: creating.id, after: { requestHash: 'x' } });

    expect((await read(appC())).payments).toEqual({ configured: true, mode: 'test', webhookRegistered: true, accountLocked: true,
      testData: { customers: 2, cards: 2, checkouts: 2, payments: 1, importedCustomers: 1, importedCards: 1 }, importedCustomersOnly: false });
    const before = await snapshot(gymC), gym = await row(gymC);

    // Without the confirmation, a live key stays refused, and nothing changes.
    const refused = await saveTo(appC(), 'rk_live_gymc');
    expect(refused.status).toBe(409);
    expect(refused.json?.error?.details).toEqual({ restrictedKey: ['mode_locked'] });
    // A charge in flight refuses the switch before any endpoint is registered for the live key.
    const pending = await factory('paymentAttempts', gymC, { invoiceId: open.id, attemptNumber: 1, status: 'pending', stripeCustomerId: customer.id });
    const busy = await saveTo(appC(), 'rk_live_gymc', { clearTestData: true });
    expect(busy.status).toBe(409);
    expect(busy.json?.error?.details).toEqual({ restrictedKey: ['payments_in_progress'] });
    expect([...account('rk_live_gymc').objects.values()].some((object) => object.object === 'webhook_endpoint')).toBe(false);
    expect(await snapshot(gymC)).toEqual({ ...before, attempts: [...before.attempts, pending] });
    expect(await row(gymC)).toEqual(gym);
    await database.forGym(gymC, (tx) => tx.update(paymentAttempts).set({ status: 'failed', resolvedAt: clock.now() }).where(eq(paymentAttempts.id, pending.id)));

    const switched = await saveTo(appC(), 'rk_live_gymc', { clearTestData: true });
    expect(switched.status, JSON.stringify(switched.json)).toBe(200);
    // The kept imported customer still ties the gym to its account.
    expect(integrationsResponseSchema.parse(switched.json).data.payments).toEqual({ configured: true, mode: 'live', webhookRegistered: true,
      accountLocked: true, testData: null, importedCustomersOnly: false });
    expect(await stripeOf(gymC)).toMatchObject({ apiKey: 'rk_live_gymc', mode: 'live' });
    const after = await snapshot(gymC);
    expect(Object.fromEntries(after.households.map((household) => [household.id, household.stripeCustomerId])))
      .toEqual({ [payer.id]: null, [matched.id]: null, [imported.id]: 'cus_ImportedLive', [creating.id]: null });
    expect(after.cards.sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ ...card, isDefault: false, revokedAt: clock.now() },
      importedCard, { ...payerImport, isDefault: false, revokedAt: clock.now() }].sort((a, b) => a.id.localeCompare(b.id)));
    expect(after.invoices.find((invoice) => invoice.id === open.id)).toMatchObject({ status: 'open', checkoutSessionId: null, checkoutExpiresAt: null });
    // The test dispute closes, so nothing reads it with the live key; the other stays open.
    expect(after.invoices.find((invoice) => invoice.id === paid.id)).toEqual({ ...before.invoices.find((invoice) => invoice.id === paid.id), disputeStatus: 'closed' });
    expect(after.invoices.find((invoice) => invoice.id === cashOnly.id)).toEqual(before.invoices.find((invoice) => invoice.id === cashOnly.id));
    expect((await audits(gymC, 'billing.invoice.disputed')).map((audit) => ({ actorUserId: audit.actorUserId, targetId: audit.targetId,
      before: audit.before, after: audit.after })))
      .toEqual([{ actorUserId: ownerC, targetId: paid.id, before: { disputeId: 'dp_test', disputeStatus: 'needs_response' },
        after: { disputeId: 'dp_test', disputeStatus: 'closed', reason: 'stripe_test_cleared' } }]);
    expect(after.attempts.find((attempt) => attempt.id === actionNeeded.id)).toMatchObject({ status: 'failed', declineCode: 'authentication_required' });
    // The test card payment stays in the books, marked as test; the cash payment is untouched.
    expect(after.payments.find((payment) => payment.id === cardPayment.id)).toEqual({ ...cardPayment, reference: stripeTestPaymentReference });
    expect(after.payments.find((payment) => payment.id === cash.id)).toEqual(cash);
    expect((await database.forGym(gymB, (tx) => tx.select().from(households).where(eq(households.id, other.id))))[0]).toEqual(other);
    // One clearing audit with what it did, and an unlink audit per household, so reservations for the old customers no longer count.
    const [cleared] = await audits(gymC, 'integrations.stripe_test_cleared');
    expect(cleared).toMatchObject({ actorUserId: ownerC, targetId: gymC,
      after: { customers: 2, cards: 2, checkouts: 2, actionNeeded: 1, payments: 1, keptImportedCustomers: 1, keptImportedCards: 1,
        reservations: 1, abandonedCreations: 1, paymentIds: [cardPayment.id], disputes: 1, disputedInvoiceIds: [paid.id] } });
    expect((await audits(gymC, 'billing.customer.unlinked')).map((audit) => [audit.targetId, audit.before]).sort())
      .toEqual([[payer.id, { customerId: customer.id }], [matched.id, { customerId: 'cus_TestMatched' }], [creating.id, { customerId: null }]].sort());
    expect((await audits(gymC, 'integrations.stripe_saved')).at(-1)).toMatchObject({ before: { mode: 'test' }, after: { mode: 'live', testDataCleared: true } });
    // The test Checkout sessions can't complete, the action-needed intent is cancelled, and the old test endpoint is gone.
    expect(test.objects.get(payLink.id)).toMatchObject({ status: 'expired' });
    expect(test.objects.get(setup.id)).toMatchObject({ status: 'expired' });
    expect(() => test.completeCheckout(payLink.id)).toThrow('Checkout is not open');
    expect(test.objects.get(String(intent.id))).toMatchObject({ status: 'canceled' });
    expect(test.objects.has(testConfig.endpointId)).toBe(false);
  });
  it('keeps live to test refused, and never touches a live-mode reference', async () => {
    const live = new StripePayments(gymC, { transport: account('rk_live_gymc'), webhookSecret: 'whsec_fixture', mode: 'live' });
    const customer = await live.createCustomer({ email: 'live@example.test', name: 'Live', householdId: uuidv7(), idempotencyKey: 'live1' });
    const household = await factory('households', gymC, { stripeCustomerId: customer.id });
    const card = await factory('paymentMethods', gymC, { householdId: household.id, processorId: 'pm_0341', isDefault: true });
    const invoice = await factory('invoices', gymC, { householdId: household.id, status: 'paid', number: 4 });
    const payment = await factory('payments', gymC, { invoiceId: invoice.id, method: 'card', paymentIntentId: 'pi_live', chargeId: 'ch_live' });
    expect((await read(appC())).payments).toMatchObject({ mode: 'live', accountLocked: true, testData: null });
    for (const extra of [{}, { clearTestData: true }]) {
      const back = await saveTo(appC(), 'rk_test_back', extra);
      expect(back.status).toBe(409);
      expect(back.json?.error?.details).toEqual({ restrictedKey: ['mode_locked'] });
    }
    // The confirmation means nothing from live: a rotated live key keeps every reference.
    const before = await snapshot(gymC);
    accounts.set('rk_live_rotated', account('rk_live_gymc'));
    expect((await saveTo(appC(), 'rk_live_rotated', { clearTestData: true })).status).toBe(200);
    expect(await snapshot(gymC)).toEqual(before);
    expect(before.households.find((row) => row.id === household.id)?.stripeCustomerId).toBe(customer.id);
    expect(before.cards.find((row) => row.id === card.id)?.revokedAt).toBeNull();
    expect(before.payments.find((row) => row.id === payment.id)?.reference).toBeNull();
    expect(await audits(gymC, 'integrations.stripe_test_cleared')).toHaveLength(1);
  });
  it('accepts any account while only imported customer IDs exist, and checks again once there are cards', async () => {
    await factory('households', gymD, { stripeCustomerId: 'cus_FromAnotherProcessor' });
    expect((await read(appD())).payments).toEqual({ configured: false, mode: null, webhookRegistered: false, accountLocked: false,
      testData: null, importedCustomersOnly: true });
    // With a card, the gym is tied to its account even before any Stripe settings are saved.
    const card = await factory('paymentMethods', gymD, { householdId: (await factory('households', gymD)).id, processorId: 'pm_FromAnotherProcessor' });
    expect((await read(appD())).payments).toMatchObject({ accountLocked: true, importedCustomersOnly: false });
    expect((await saveTo(appD(), 'rk_test_gymd')).json?.error?.details).toEqual({ restrictedKey: ['account_locked'] });
    await database.forGym(gymD, (tx) => tx.delete(paymentMethods).where(eq(paymentMethods.id, card.id)));
    const fresh = account('rk_test_gymd');
    fresh.requests.length = 0;
    const saved = await saveTo(appD(), 'rk_test_gymd');
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    // No account check: the new key was never asked for the imported customer.
    expect(fresh.requests.some((request) => request.path.includes('cus_FromAnotherProcessor'))).toBe(false);
    expect(integrationsResponseSchema.parse(saved.json).data.payments).toMatchObject({ configured: true, mode: 'test', importedCustomersOnly: false });
  });
});

describe('Settings → Backups', () => {
  it('activates a new destination and key only after the owner proves they saved the private key', async () => {
    const before = await read();
    expect(before.backups).toEqual({ configured: false, destination: null, publicKey: null, pending: null, retentionBudgetBytes: 8_000_000_000 });
    // A destination that refuses its credentials gets no key, and nothing is stored.
    checkDestination.mockRejectedValueOnce(new Error('InvalidAccessKeyId ' + storageSecret));
    const unreachable = await call(server(), 'POST', '/backups', { revision: before.revision, destination: destination('typo') });
    expect(unreachable.status).toBe(400);
    expect(unreachable.json?.error?.details).toEqual({ destination: ['unreachable'] });
    expect(checkDestination).toHaveBeenLastCalledWith(expect.objectContaining({ bucket: 'typo', secretAccessKey: storageSecret }), gymA);
    expect((await row()).revision).toBe(before.revision);
    const created = createBackupKeyResponseSchema.parse((await call(server(), 'POST', '/backups', { revision: before.revision, destination: destination('first') })).json).data;
    expect(created.integrations.backups).toMatchObject({ configured: false, publicKey: null,
      pending: { destination: { endpoint: 'https://s3.example.test', region: 'auto', bucket: 'first' }, publicKey: created.publicKey } });
    expect(await row()).toMatchObject({ backupPublicKey: null, backupDestination: null, s3Config: null, backupBlobKey: null });
    const other = await call(server(), 'POST', '/backups', { revision: created.integrations.revision, destination: destination('first') });
    const second = createBackupKeyResponseSchema.parse(other.json).data;
    const wrong = await call(server(), 'POST', '/backups/confirm', { revision: second.integrations.revision, privateKey: created.privateKey });
    expect(wrong.status).toBe(400);
    expect(wrong.json?.error?.details).toEqual({ privateKey: ['mismatch'] });
    const confirmed = integrationsResponseSchema.parse((await call(server(), 'POST', '/backups/confirm',
      { revision: second.integrations.revision, privateKey: second.privateKey })).json).data;
    expect(confirmed.backups).toEqual({ configured: true, destination: { endpoint: 'https://s3.example.test', region: 'auto', bucket: 'first' },
      publicKey: second.publicKey, pending: null, retentionBudgetBytes: 8_000_000_000 });
    const gym = await row();
    expect(JSON.parse(decryptSecret(key, { secretClass: 's3_config', owner: gymA }, gym.s3Config!))).toEqual({ accessKeyId: storageKeyId, secretAccessKey: storageSecret });
    expect(gym.backupBlobKey).not.toBeNull();
    const audits = await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.targetId, gymA)));
    expect(audits.filter((audit) => audit.action.startsWith('integrations.backup_')).map((audit) => audit.action).sort())
      .toEqual(['integrations.backup_key_confirmed', 'integrations.backup_key_created', 'integrations.backup_key_created']);
  });
  it('keeps the current destination, key and blob key working while a change waits for confirmation', async () => {
    const before = await row(), current = await read();
    const created = createBackupKeyResponseSchema.parse((await call(server(), 'POST', '/backups', { revision: current.revision, destination: destination('second') })).json).data;
    const pending = await row();
    expect(pending).toMatchObject({ backupPublicKey: before.backupPublicKey, backupDestination: before.backupDestination, s3Config: before.s3Config, backupBlobKey: before.backupBlobKey });
    expect(created.integrations.backups).toMatchObject({ configured: true, destination: { bucket: 'first' }, pending: { destination: { bucket: 'second' } } });
    expect((await call(server(), 'POST', '/backups/confirm', { revision: created.integrations.revision - 1, privateKey: created.privateKey })).status).toBe(409);
    requestSnapshot.mockClear();
    // A snapshot that can't be queued leaves the confirmed change in place.
    requestSnapshot.mockRejectedValueOnce(new Error('queue unavailable'));
    const confirmed = integrationsResponseSchema.parse((await call(server(), 'POST', '/backups/confirm', { revision: created.integrations.revision, privateKey: created.privateKey })).json).data;
    expect(confirmed.backups).toMatchObject({ destination: { bucket: 'second' }, publicKey: created.publicKey, pending: null });
    // The new destination and key get a snapshot right away, queued once for this change.
    expect(requestSnapshot).toHaveBeenCalledExactlyOnceWith('settings:' + gymA + ':' + confirmed.revision);
    // Snapshot reference lists are authenticated with the blob key: a destination keeps it across key changes.
    expect((await row()).backupBlobKey).toBe(before.backupBlobKey);
    expect((await call(server(), 'POST', '/backups/confirm', { revision: confirmed.revision, privateKey: created.privateKey })).json?.error?.details)
      .toEqual({ privateKey: ['no_pending_key'] });
  });
  it('reads a backup destination and a pending change a newer release added keys to', async () => {
    const before = await row(), current = await read();
    const created = createBackupKeyResponseSchema.parse((await call(server(), 'POST', '/backups', { revision: current.revision, destination: destination('third') })).json).data;
    const pending = await row(), settings = pending.settings as { integrations: { backup: { destination: object } } };
    const newer = { integrations: { backup: { ...settings.integrations.backup, newerKey: true, destination: { ...settings.integrations.backup.destination, newerKey: true } } } };
    await database.forGym(gymA, (tx) => tx.update(gyms).set({ settings: newer, backupDestination: { ...before.backupDestination as object, newerKey: true } }).where(eq(gyms.id, gymA)));
    const status = await read();
    expect(status.backups).toMatchObject({ destination: { bucket: 'second' }, pending: { destination: { bucket: 'third' }, publicKey: created.publicKey } });
    expect(JSON.stringify(status)).not.toContain('newerKey');
    await database.forGym(gymA, (tx) => tx.update(gyms).set({ settings: before.settings, backupDestination: before.backupDestination }).where(eq(gyms.id, gymA)));
  });
  it('has no backups section in multi-gym mode', async () => {
    const multiEnv = { ...installEnv, TENANCY: 'multi', AUTH_PASSWORD_LOGIN: 'off', GYM_INTEGRATIONS: 'gym' };
    const multi = server({ gymId: gymB, routesService: createIntegrationsService({ ...base, env: multiEnv, config: authConfig(multiEnv) }) });
    const status = await read(multi);
    expect(status.backups).toBeNull();
    expect((await call(multi, 'POST', '/backups', { revision: status.revision, destination: destination('multi') })).status).toBe(404);
    // A tenant's test connection goes only to SMTP ports, so it can't probe the install's other services.
    const probe = await call(multi, 'PUT', '/email', email(status.revision, { port: 5432 }));
    expect(probe.status).toBe(400);
    expect(probe.json?.error?.details).toEqual({ port: ['port_not_allowed'] });
    expect(sendTest).not.toHaveBeenCalled();
    expect((await row(gymB)).settings).toEqual({});
  });
});

describe('integration settings in a sandbox and in logs', () => {
  it('logs an unreadable SMTP value once across settings reads, and retries changed values and keys', async () => {
    const original = (await row(gymB)).smtpConfig;
    const lines: string[] = [], previous = setLogSink((line) => lines.push(line));
    const otherKey = Buffer.alloc(32, 1);
    const corrupt = () => encryptSecret(otherKey, { secretClass: 'smtp_config', owner: gymB }, JSON.stringify({
      host: 'smtp.example.test', port: 587, security: 'starttls', from: 'desk@example.test', username: 'user', password: smtpPassword,
    }));
    try {
      const value = corrupt();
      await database.forGym(gymB, (tx) => tx.update(gyms).set({ smtpConfig: value }).where(eq(gyms.id, gymB)));
      for (let i = 0; i < 3; i++) expect((await read(server({ gymId: gymB }))).email.host).toBeNull();
      expect(lines.filter((line) => line.includes('settings.smtp_config_unreadable'))).toHaveLength(1);
      const decrypting = createIntegrationsService({ ...base, key: otherKey });
      expect((await read(server({ gymId: gymB, routesService: decrypting }))).email.host).toBe('smtp.example.test');
      await database.forGym(gymB, (tx) => tx.update(gyms).set({ smtpConfig: corrupt() }).where(eq(gyms.id, gymB)));
      await read(server({ gymId: gymB }));
      expect(lines.filter((line) => line.includes('settings.smtp_config_unreadable'))).toHaveLength(2);
      expect(lines.join('')).not.toContain(smtpPassword);
      expect(lines.join('')).not.toContain(value);
    } finally {
      setLogSink(previous);
      await database.forGym(gymB, (tx) => tx.update(gyms).set({ smtpConfig: original }).where(eq(gyms.id, gymB)));
    }
  });
  it('shows a sandbox’s integrations read-only', async () => {
    const sandbox = server({ gymId: gymB, routesService: createIntegrationsService({ ...base, sandbox: true }) });
    const status = await read(sandbox);
    expect(status).toMatchObject({ sandbox: true, backups: null, email: { signIn: { magicLink: true } } });
    expect((await call(sandbox, 'PUT', '/email', email(status.revision))).status).toBe(403);
    expect((await call(sandbox, 'PUT', '/stripe', { revision: status.revision, restrictedKey: 'rk_test_sandbox' })).status).toBe(403);
    expect(sendTest).not.toHaveBeenCalled();
  });
  it('logs a Stripe failure without its message', async () => {
    const lines: string[] = [], previous = setLogSink((line) => lines.push(line));
    try {
      // The permission probe passes; reading the gym's customer then fails with an error that quotes the key.
      const reachable = account('rk_test_rotated'), request = reachable.request.bind(reachable);
      accounts.set('rk_test_broken', Object.assign(Object.create(reachable) as StripeFixtures, {
        request: async (input: Parameters<StripeFixtures['request']>[0]) => {
          if (input.method === 'GET' && input.path.startsWith('/v1/customers/cus_')) throw new Error('connection reset for rk_test_broken');
          return request(input);
        } }));
      const response = await call(server(), 'PUT', '/stripe', { revision: (await read()).revision, restrictedKey: 'rk_test_broken' });
      expect(response.status).toBe(503);
    } finally { setLogSink(previous); }
    expect(lines.join('\n')).not.toContain('rk_test_broken');
  });
  it('never returns or audits a credential, private key or webhook secret', async () => {
    const config = (await stripeOf())!;
    const audits = await database.forGym(gymA, (tx) => tx.select().from(auditEvents));
    const text = seen.filter((body) => !body.includes('"privateKey"')).join('\n') + JSON.stringify(audits);
    for (const secret of [smtpPassword, storageSecret, storageKeyId, config.apiKey, config.webhookSecret, 'AGE-SECRET-KEY-', 'gym-user', 'rk_test_', 'whsec_'])
      expect(text, secret).not.toContain(secret);
    // Only the key creation response carries the new private key.
    expect(seen.filter((body) => body.includes('AGE-SECRET-KEY-')).every((body) => body.includes('"privateKey"'))).toBe(true);
  });
});
