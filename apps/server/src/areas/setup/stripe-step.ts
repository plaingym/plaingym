// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { forGym, gyms, revisionGuard, assertRevised, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import type { SetupStripeRequest } from '@plaingym/shared/contracts';
import type { MutationContext } from '../../core/interfaces/common.js';
import { clock as systemClock } from '../../core/clock.js';
import { encryptSecret, decryptSecret } from '../../core/secrets.js';
import { logError, logInfo } from '../../core/log.js';
import { StripePayments, stripeTransport } from '../../infra/payments/stripe.js';
import { stripeProvisioner } from '../../infra/payments/setup.js';

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
    const config = JSON.parse(decryptSecret(key, 'stripe_config', encrypted)) as StripeConfig;
    if (!['test', 'live'].includes(config.mode) || typeof config.apiKey !== 'string' || typeof config.endpointId !== 'string' || typeof config.webhookSecret !== 'string') throw new Error('Invalid Stripe configuration');
    return config;
  } catch (error) { logError('payments.stored_config_unreadable', { gymId }, error); return null; }
}
export function createStripeStep(options: { key: Buffer; origin: string; clock?: Clock; scope?: typeof forGym;
  provisioner?: (key: string) => StripeProvisioner }) {
  const scope = options.scope ?? forGym, clock = options.clock ?? systemClock;
  async function current(context: MutationContext, revision: number) {
    return scope(context.gymId, async (tx) => {
      const [gym] = await tx.select().from(gyms).where(eq(gyms.id, context.gymId));
      const state = gym?.settings as { setup?: { completed?: boolean; ownerId?: string; completedSteps?: number[] } } | undefined;
      if (!gym || !state?.setup || state.setup.completed || context.actor.kind !== 'user' || state.setup.ownerId !== context.actor.userId)
        throw new AppError('not_found', 'Setup not found');
      assertRevised(gym.revision === revision ? [gym] : []);
      if (!state.setup.completedSteps?.includes(5)) throw new AppError('conflict', 'Complete the preceding setup step');
      return gym;
    });
  }
  return {
    async configure(context: MutationContext, input: SetupStripeRequest) {
      const before = await current(context, input.revision);
      const previous = readStripeConfig(options.key, before.stripeConfig, context.gymId);
      let config: StripeConfig | null = null, reused = false;
      if (input.choice === 'configure') {
        if (!/^rk_(test|live)_[A-Za-z0-9]+$/.test(input.restrictedKey)) throw new AppError('invalid_request', 'A restricted Stripe key is required');
        const mode = input.restrictedKey.startsWith('rk_test_') ? 'test' : 'live';
        if (mode === 'live' && process.env.DEMO_MODE === 'true') throw new AppError('invalid_request', 'Demo mode requires a test-mode key');
        const provisioner = provisionerFor(options.provisioner, input.restrictedKey, mode);
        await provisioner.validate();
        // The signing secret exists only at creation, so a stored endpoint the new key can still see is kept (and its events
        // brought up to date); otherwise a new one is created. Nothing is deleted until the new settings are saved.
        const endpoint = await provisioner.register(context.gymId, options.origin, input.revision,
          previous ? { endpointId: previous.endpointId, webhookSecret: previous.webhookSecret } : undefined);
        config = { apiKey: input.restrictedKey, mode, endpointId: endpoint.endpointId, webhookSecret: endpoint.webhookSecret };
        reused = endpoint.reused;
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
        const updated = assertRevised(await tx.update(gyms).set({
          stripeConfig: config ? encryptSecret(options.key, 'stripe_config', JSON.stringify(config)) : null,
          settings: { ...gym.settings as object, setup: { ...state.setup,
            completedSteps: [...new Set([...(state.setup.completedSteps ?? []), 6])].sort((a, b) => a - b) } },
          revision: guard.next, updatedAt: clock.now(),
        }).where(and(eq(gyms.id, context.gymId), guard.matches)).returning());
        await writeAudit(tx, { gymId: context.gymId, actorKind: 'user', actorUserId: context.actor.userId,
          action: 'setup.stripe_configured', targetType: 'gym', targetId: context.gymId,
          after: { configured: !!config, mode: config?.mode ?? null, endpointId: config?.endpointId ?? null, endpointReused: reused }, occurredAt: clock.now() });
        return { configured: !!config, mode: config?.mode ?? null, webhookRegistered: !!config, revision: updated.revision };
      });
      await retireStale(context.gymId, previous, config, reused);
      return saved;
    },
  };
  /** After the new settings are saved: delete this gym's other endpoints, then the old one if the key moved to another account. Failures are logged, never raised. */
  async function retireStale(gymId: string, previous: StripeConfig | null, config: StripeConfig | null, kept: boolean): Promise<void> {
    if (config) {
      try {
        const retired = await provisionerFor(options.provisioner, config.apiKey, config.mode).retire(gymId, options.origin, config.endpointId);
        if (retired.deleted.length) logInfo('payments.webhook_endpoints_retired', { gymId, count: retired.deleted.length });
        for (const failure of retired.failures) logError('payments.webhook_endpoint_retire_failed', { gymId }, failure);
      } catch (error) { logError('payments.webhook_endpoint_retire_failed', { gymId }, error); }
    }
    if (previous && !kept) {
      try {
        // The previous key may belong to another account, or no longer be accepted.
        if (await provisionerFor(options.provisioner, previous.apiKey, previous.mode).remove(gymId, options.origin, previous.endpointId))
          logInfo('payments.webhook_endpoints_retired', { gymId, count: 1 });
      } catch (error) { logError('payments.webhook_endpoint_remove_failed', { gymId }, error); }
    }
  }
}
export function createPaymentsResolver(options: { key: Buffer; scope?: typeof forGym; clock?: Clock }) {
  const scope = options.scope ?? forGym;
  return async (gymId: string) => {
    const encrypted = await scope(gymId, async (tx) => (await tx.select({ config: gyms.stripeConfig }).from(gyms).where(eq(gyms.id, gymId)))[0]?.config);
    if (!encrypted) return null;
    const config = JSON.parse(decryptSecret(options.key, 'stripe_config', encrypted)) as StripeConfig;
    if (!['test', 'live'].includes(config.mode) || !new RegExp('^rk_' + config.mode + '_[A-Za-z0-9]+$').test(config.apiKey)) throw new Error('Invalid Stripe configuration');
    return new StripePayments(gymId, { transport: stripeTransport(config.apiKey), webhookSecret: config.webhookSecret, mode: config.mode,
      ...(options.clock ? { clock: options.clock } : {}) });
  };
}
