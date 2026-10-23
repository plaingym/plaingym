// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { forGym, gyms, revisionGuard, assertRevised, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import type { SetupStripeRequest } from '@plaingym/shared/contracts';
import type { MutationContext } from '../../core/interfaces/common.js';
import { clock as systemClock } from '../../core/clock.js';
import { encryptSecret, decryptSecret } from '../../core/secrets.js';
import { StripePayments, stripeTransport } from '../../infra/payments/stripe.js';
import { stripeProvisioner } from '../../infra/payments/setup.js';

export interface StripeConfig { apiKey: string; endpointId: string; webhookSecret: string; mode: 'test' | 'live' }
export function createStripeStep(options: { key: Buffer; origin: string; clock?: Clock; scope?: typeof forGym;
  provisioner?: (key: string) => ReturnType<typeof stripeProvisioner> }) {
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
      await current(context, input.revision);
      let config: StripeConfig | null = null;
      if (input.choice === 'configure') {
        if (!/^rk_(test|live)_[A-Za-z0-9]+$/.test(input.restrictedKey)) throw new AppError('invalid_request', 'A restricted Stripe key is required');
        const mode = input.restrictedKey.startsWith('rk_test_') ? 'test' : 'live';
        if (mode === 'live' && process.env.DEMO_MODE === 'true') throw new AppError('invalid_request', 'Demo mode requires a test-mode key');
        const provisioner = options.provisioner?.(input.restrictedKey) ?? stripeProvisioner(stripeTransport(input.restrictedKey), mode);
        await provisioner.validate();
        const endpoint = await provisioner.register(context.gymId, options.origin, input.revision);
        config = { apiKey: input.restrictedKey, mode, ...endpoint };
      }
      // Registration is idempotent. A failed CAS leaves an unreferenced test endpoint, never active credentials.
      // The integration owner can retry the same revision/key; do not delete another worker's endpoint.
      return scope(context.gymId, async (tx) => {
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
          after: { configured: !!config, mode: config?.mode ?? null, endpointId: config?.endpointId ?? null }, occurredAt: clock.now() });
        return { configured: !!config, mode: config?.mode ?? null, webhookRegistered: !!config, revision: updated.revision };
      });
    },
  };
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
