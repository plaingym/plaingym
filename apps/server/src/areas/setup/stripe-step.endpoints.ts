// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { forGym, gyms, writeAudit } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { clock as systemClock } from '../../core/clock.js';
import { logError, logInfo } from '../../core/log.js';
import { encryptSecret } from '../../core/secrets.js';
import { provisionerFor, readStripeConfig, type StripeConfig, type StripeProvisioner } from './stripe-step.js';

/**
 * Keeps each gym's stored webhook endpoint in line with this release: the subscribed events, and the pinned API version.
 * Stripe cannot change an endpoint's API version, so a different version replaces the endpoint and stores its new
 * signing secret. An endpoint deleted in the Stripe dashboard is recreated the same way, since the key is only saved in setup. Stripe being unreachable is logged and retried at the next start or Stripe settings save.
 */
export function createStripeEndpointCheck(options: { key: Buffer; gyms: () => Promise<readonly { gymId: string }[]>;
  origin: (gymId: string) => Promise<string>; clock?: Clock; scope?: typeof forGym; provisioner?: (key: string) => StripeProvisioner;
  stopped?: () => boolean }) {
  const scope = options.scope ?? forGym, clock = options.clock ?? systemClock;
  const stored = (gymId: string) => scope(gymId, async (tx) => (await tx.select({ config: gyms.stripeConfig }).from(gyms).where(eq(gyms.id, gymId)))[0]?.config ?? null);

  async function replace(gymId: string, origin: string, encrypted: string, config: StripeConfig, provisioner: StripeProvisioner,
    next: { endpointId: string; webhookSecret: string }, action: 'replaced' | 'recreated'): Promise<void> {
    const saved = await scope(gymId, async (tx) => {
      const rows = await tx.update(gyms).set({
        stripeConfig: encryptSecret(options.key, 'stripe_config', JSON.stringify({ ...config, ...next })), updatedAt: clock.now(),
      }).where(and(eq(gyms.id, gymId), eq(gyms.stripeConfig, encrypted))).returning({ id: gyms.id });
      if (!rows.length) return false;
      await writeAudit(tx, { gymId, actorKind: 'system', action: 'payments.webhook_endpoint_' + action, targetType: 'gym', targetId: gymId,
        before: { endpointId: config.endpointId }, after: { endpointId: next.endpointId }, occurredAt: clock.now() });
      return true;
    });
    if (saved) {
      const retired = await provisioner.retire(gymId, origin, next.endpointId);
      for (const failure of retired.failures) logError('payments.webhook_endpoint_retire_failed', { gymId }, failure);
      return;
    }
    // The settings changed while Stripe was called. Delete the new endpoint unless the concurrent writer saved this same one.
    const current = readStripeConfig(options.key, await stored(gymId), gymId);
    if (current?.endpointId !== next.endpointId) await provisioner.remove(gymId, origin, next.endpointId);
  }

  async function checkGym(gymId: string): Promise<string> {
    const encrypted = await stored(gymId), config = readStripeConfig(options.key, encrypted, gymId);
    if (!encrypted || !config) return 'none';
    const origin = await options.origin(gymId), provisioner = provisionerFor(options.provisioner, config.apiKey, config.mode);
    const result = await provisioner.check(gymId, origin, { endpointId: config.endpointId, webhookSecret: config.webhookSecret });
    if (result.status === 'replaced' || result.status === 'recreated') await replace(gymId, origin, encrypted, config, provisioner, result.registration, result.status);
    return result.status;
  }

  return {
    /** One pass over every gym with Stripe settings. Never throws: each gym's failure is logged and the pass continues. */
    async run(): Promise<void> {
      let list: readonly { gymId: string }[];
      try { list = await options.gyms(); } catch (error) { logError('payments.webhook_check_failed', {}, error); return; }
      for (const { gymId } of list) {
        if (options.stopped?.()) return;
        try {
          const status = await checkGym(gymId);
          if (status !== 'none' && status !== 'current') logInfo('payments.webhook_endpoint_' + status, { gymId });
        } catch (error) { logError('payments.webhook_check_failed', { gymId }, error); }
      }
    },
  };
}
