// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { forGym, gyms, revisionGuard, assertRevised, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { restrictedKeyPattern, type SetupStripeRequest } from '@plaingym/shared/contracts';
import type { MutationContext } from '../../core/interfaces/common.js';
import { clock as systemClock } from '../../core/clock.js';
import { encryptSecret, decryptSecret } from '../../core/secrets.js';
import { logError, logInfo } from '../../core/log.js';
import { StripePayments, stripeTransport } from '../../infra/payments/stripe.js';
import { StripePermissionError, stripeProvisioner } from '../../infra/payments/setup.js';
import type { PaymentTransport } from '../../infra/payments/transport.js';
import { pauseRestoredBillingForStripe } from '../settings/go-live.restore.js';
import { importedOnly, readsStripeReference, savedStripeMode, stripeReference } from '../settings/integrations.query.js';

export interface StripeConfig { apiKey: string; endpointId: string; webhookSecret: string; mode: 'test' | 'live' }
export type StripeProvisioner = ReturnType<typeof stripeProvisioner>;
/** The provisioner for one Stripe key: tests supply fakes, production talks to Stripe. */
export function provisionerFor(factory: ((key: string) => StripeProvisioner) | undefined, apiKey: string, mode: 'test' | 'live'): StripeProvisioner {
  return factory?.(apiKey) ?? stripeProvisioner(stripeTransport(apiKey), mode);
}
/** A gym's stored Stripe settings, or null when none are saved or they cannot be read. */
export function readStripeConfig(key: Buffer, encrypted: string | null, gymId: string): StripeConfig | null {
  if (!encrypted) return null;
  try {
    const config = JSON.parse(decryptSecret(key, { secretClass: 'stripe_config', owner: gymId }, encrypted)) as StripeConfig;
    if (!['test', 'live'].includes(config.mode) || typeof config.apiKey !== 'string' || typeof config.endpointId !== 'string' || typeof config.webhookSecret !== 'string') throw new Error('Invalid Stripe configuration');
    return config;
  } catch (error) { logError('payments.stored_config_unreadable', { gymId }, error); return null; }
}
/** The mode a restricted key belongs to, or a 400 for anything but a restricted key (a sandbox accepts test mode only). */
export function restrictedKeyMode(restrictedKey: string, demoMode = false): 'test' | 'live' {
  if (!restrictedKeyPattern.test(restrictedKey)) throw new AppError('invalid_request', 'A restricted Stripe key is required');
  const mode = restrictedKey.startsWith('rk_test_') ? 'test' : 'live';
  if (mode === 'live' && demoMode) throw new AppError('invalid_request', 'Demo mode requires a test-mode key');
  return mode;
}
/**
 * The Stripe key lifecycle shared by setup step 6 and Settings → Payments: `connect` probes a new restricted key's
 * permissions and registers (or reuses) the gym's webhook endpoint, all outside any transaction; the caller saves the
 * result, then calls `retireStale`.
 */
export function createStripeConnection(options: { provisioner?: ((key: string) => StripeProvisioner) | undefined; demoMode?: boolean | undefined }) {
  return {
    /** `checked` runs after the permission probe and before any endpoint is registered (Settings checks the account there). */
    async connect(gymId: string, origin: string, revision: number, restrictedKey: string, previous: StripeConfig | null,
      checked?: () => Promise<void>): Promise<{ config: StripeConfig; reused: boolean }> {
      const mode = restrictedKeyMode(restrictedKey, options.demoMode);
      const provisioner = provisionerFor(options.provisioner, restrictedKey, mode);
      await provisioner.validate();
      await checked?.();
      // The signing secret exists only at creation, so a stored endpoint the new key can still see is kept (and its events
      // brought up to date); otherwise a new one is created. Nothing is deleted until the new settings are saved.
      const endpoint = await provisioner.register(gymId, origin, revision,
        previous ? { endpointId: previous.endpointId, webhookSecret: previous.webhookSecret } : undefined);
      return { config: { apiKey: restrictedKey, mode, endpointId: endpoint.endpointId, webhookSecret: endpoint.webhookSecret }, reused: endpoint.reused };
    },
    /** After the new settings are saved: delete this gym's other endpoints, then the old one if the key moved to another account. Failures are logged, never raised. */
    async retireStale(gymId: string, origin: string, previous: StripeConfig | null, config: StripeConfig | null, kept: boolean): Promise<void> {
      if (config) {
        try {
          const retired = await provisionerFor(options.provisioner, config.apiKey, config.mode).retire(gymId, origin, config.endpointId);
          if (retired.deleted.length) logInfo('payments.webhook_endpoints_retired', { gymId, count: retired.deleted.length });
          for (const failure of retired.failures) logError('payments.webhook_endpoint_retire_failed', { gymId }, failure);
        } catch (error) { logError('payments.webhook_endpoint_retire_failed', { gymId }, error); }
      }
      if (previous && !kept) {
        try {
          // The previous key may belong to another account, or no longer be accepted.
          if (await provisionerFor(options.provisioner, previous.apiKey, previous.mode).remove(gymId, origin, previous.endpointId))
            logInfo('payments.webhook_endpoints_retired', { gymId, count: 1 });
        } catch (error) { logError('payments.webhook_endpoint_remove_failed', { gymId }, error); }
      }
    },
  };
}
/**
 * Stripe's answer to a key change as a safe error, for setup and Settings → Payments: an `AppError` is kept, a missing
 * permission names its resource, and anything else is `unavailable`, logged as `event` without Stripe's message.
 */
export function stripeFailure(gymId: string, error: unknown, event: string): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof StripePermissionError)
    return new AppError('invalid_request', 'Check the Stripe permission for ' + error.resource, { restrictedKey: ['missing_permission'] });
  logError(event, { gymId }, error);
  return new AppError('unavailable', 'Stripe could not be reached or refused the key');
}
export function createStripeStep(options: { key: Buffer; origin: string; clock?: Clock; scope?: typeof forGym;
  /** A sandbox accepts test-mode keys only. */
  demoMode?: boolean; provisioner?: (key: string) => StripeProvisioner;
  /** The transport that reads the gym's Stripe references with a new key: tests supply fakes, production talks to Stripe. */
  transport?: (key: string) => PaymentTransport }) {
  const scope = options.scope ?? forGym, clock = options.clock ?? systemClock;
  const transportFor = options.transport ?? ((apiKey: string) => stripeTransport(apiKey));
  const connection = createStripeConnection({ provisioner: options.provisioner, demoMode: options.demoMode });
  async function current(context: MutationContext, revision: number, references: boolean) {
    return scope(context.gymId, async (tx) => {
      const [gym] = await tx.select().from(gyms).where(eq(gyms.id, context.gymId));
      const state = gym?.settings as { setup?: { completed?: boolean; ownerId?: string; completedSteps?: number[] } } | undefined;
      if (!gym || !state?.setup || state.setup.completed || context.actor.kind !== 'user' || state.setup.ownerId !== context.actor.userId)
        throw new AppError('not_found', 'Setup not found');
      assertRevised(gym.revision === revision ? [gym] : []);
      if (!state.setup.completedSteps?.includes(5)) throw new AppError('conflict', 'Complete the preceding setup step');
      return { gym, reference: references ? await stripeReference(tx, context.gymId) : null,
        saved: references ? await savedStripeMode(tx, context.gymId) : null };
    });
  }
  return {
    /**
     * Saves or skips the gym's Stripe key. While the gym holds Stripe customers, cards or card payments (a restore can
     * bring them into an unfinished wizard), a key is held to the same rules as Settings → Payments: one in the other mode
     * is refused, and a same-mode key must read one of them. With no key stored (after a skip, or settings that can't
     * be read), the latest saved key's mode is the one compared while the app's own references exist (customers it
     * linked, attempts, card payments or cards saved through Stripe), not for imported IDs and cards alone. Setup offers
     * no switch from test to live; the owner makes it later in Settings → Payments.
     */
    async configure(context: MutationContext, input: SetupStripeRequest) {
      const { gym: before, reference, saved: savedMode } = await current(context, input.revision, input.choice === 'configure');
      const previous = readStripeConfig(options.key, before.stripeConfig, context.gymId);
      let config: StripeConfig | null = null, reused = false, checked: { paths: string[] } | null = null;
      if (input.choice === 'configure') {
        const mode = restrictedKeyMode(input.restrictedKey, options.demoMode);
        const locked = previous?.mode ?? (reference?.own ? savedMode : null);
        if (reference && locked && locked !== mode)
          throw new AppError('invalid_request', 'Stripe customers and payments exist in ' + locked + ' mode', { restrictedKey: ['mode_locked'] });
        checked = reference && !importedOnly(previous, reference) ? reference : null;
        try {
          // After the permission probe, so a key missing a permission is told which one; before any endpoint is registered.
          ({ config, reused } = await connection.connect(context.gymId, options.origin, input.revision, input.restrictedKey, previous, async () => {
            if (checked && !await readsStripeReference(transportFor(input.restrictedKey), checked))
              throw new AppError('invalid_request', 'The key belongs to another Stripe account', { restrictedKey: ['account_locked'] });
          }));
        } catch (error) { throw stripeFailure(context.gymId, error, 'setup.stripe_key_failed'); }
      }
      // Registration is idempotent. A failed CAS leaves an unreferenced endpoint, never active credentials; the next
      // successful save deletes it with the gym's other stale endpoints.
      const saved = await scope(context.gymId, async (tx) => {
        const [gym] = await tx.select().from(gyms).where(eq(gyms.id, context.gymId)).for('update');
        const state = gym?.settings as { setup?: { completed?: boolean; ownerId?: string; completedSteps?: number[] } } | undefined;
        if (!gym || state?.setup?.completed || context.actor.kind !== 'user' || state?.setup?.ownerId !== context.actor.userId)
          throw new AppError('not_found', 'Setup not found');
        const guard = revisionGuard(gyms.revision, input.revision);
        assertRevised(gym.revision === input.revision ? [gym] : []);
        // The mode stored when this save locked the gym row: the billing write guard counts a change or removal of it.
        const was = readStripeConfig(options.key, gym.stripeConfig, context.gymId);
        if (config && !checked) {
          // A card or payment recorded while Stripe was called would need the account check, which ran without one.
          const now = await stripeReference(tx, context.gymId);
          if (now !== null && !importedOnly(was, now)) throw new AppError('conflict', 'Stripe customers were recorded while the key was checked; try again');
        }
        const paused = config && await pauseRestoredBillingForStripe(tx, context, gym.billingEnabled, clock.now(), config.mode);
        const updated = assertRevised(await tx.update(gyms).set({
          ...(paused ? { billingEnabled: false } : {}),
          stripeConfig: config ? encryptSecret(options.key, { secretClass: 'stripe_config', owner: context.gymId }, JSON.stringify(config)) : null,
          settings: { ...gym.settings as object, setup: { ...state.setup,
            completedSteps: [...new Set([...(state.setup.completedSteps ?? []), 6])].sort((a, b) => a - b) } },
          revision: guard.next, updatedAt: clock.now(),
        }).where(and(eq(gyms.id, context.gymId), guard.matches)).returning());
        await writeAudit(tx, { gymId: context.gymId, actorKind: 'user', actorUserId: context.actor.userId,
          action: 'setup.stripe_configured', targetType: 'gym', targetId: context.gymId, before: { mode: was?.mode ?? null },
          after: { configured: !!config, mode: config?.mode ?? null, endpointId: config?.endpointId ?? null, endpointReused: reused }, occurredAt: clock.now() });
        return { configured: !!config, mode: config?.mode ?? null, webhookRegistered: !!config, revision: updated.revision };
      });
      await connection.retireStale(context.gymId, options.origin, previous, config, reused);
      return saved;
    },
  };
}
export function createPaymentsResolver(options: { key: Buffer; scope?: typeof forGym; clock?: Clock }) {
  const scope = options.scope ?? forGym;
  return async (gymId: string) => {
    const encrypted = await scope(gymId, async (tx) => (await tx.select({ config: gyms.stripeConfig }).from(gyms).where(eq(gyms.id, gymId)))[0]?.config);
    if (!encrypted) return null;
    const config = JSON.parse(decryptSecret(options.key, { secretClass: 'stripe_config', owner: gymId }, encrypted)) as StripeConfig;
    if (!['test', 'live'].includes(config.mode) || !new RegExp('^rk_' + config.mode + '_[A-Za-z0-9]+$').test(config.apiKey)) throw new Error('Invalid Stripe configuration');
    return new StripePayments(gymId, { transport: stripeTransport(config.apiKey), webhookSecret: config.webhookSecret, mode: config.mode,
      ...(options.clock ? { clock: options.clock } : {}) });
  };
}
