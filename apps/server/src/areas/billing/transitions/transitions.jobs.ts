// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../../core/registry.js';
import type { TransitionEffects } from './effects.js';
import { effectJob } from './effects.js';
import { idSchema } from '@plaingym/shared/contracts';

let configured: TransitionEffects | undefined;
export function configureTransitionEffects(effects: TransitionEffects) { configured = effects; }
export function createTransitionJobs(read: () => TransitionEffects | undefined = () => configured): readonly JobRegistration[] {
  return [
    { id: 'billing.transitions.publish', cron: '* * * * *', async handler(_payload, context) {
      await read()?.publish(context.gymId);
    } },
    { id: effectJob, async handler(payload, context) {
      const service = read();
      if (!service) throw new Error('Invoice transition effects are not configured');
      await service.run(idSchema.parse((payload as { effectId?: unknown } | null)?.effectId), context);
    } },
  ];
}
export const jobs = createTransitionJobs();
