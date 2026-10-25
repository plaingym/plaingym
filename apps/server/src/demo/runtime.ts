// SPDX-License-Identifier: AGPL-3.0-only
import { forSystem, gyms } from '@plaingym/db';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { clock as defaultClock } from '../core/clock.js';
import { tenancyMode } from '../core/tenancy.js';
import type { ClientIpOptions } from '../core/rate-limit.js';
import { decryptSecret, parseEncryptionKey } from '../core/secrets.js';
import { authConfig } from '../infra/auth/config.js';
import { OutboxEmail } from '../infra/email/outbox.js';
import { createGymDeleteService } from '../areas/settings/gym-delete.js';
import { configureGymDeletion } from '../areas/settings/gym-delete.routes.js';
import { demoBootCheck } from './config.js';
import { createDemoService } from './service.js';
import { createDemoIdentities } from './identities.js';
import { configureDemoRoutes, disableDemoRoutes } from './demo.routes.js';
import { registerDemoCleanup } from './demo.jobs.js';
import { runSeeds } from './seed/index.js';
import { renderDemoLogin } from '../emails/demo/demo.js';

export async function verifyDemoStoredKeys(key: Buffer, system: typeof forSystem = forSystem): Promise<void> {
  const rows = await system((tx) => tx.select({ stripe: gyms.stripeConfig }).from(gyms));
  for (const row of rows) if (row.stripe && /(?:sk|rk|pk)_live_/i.test(decryptSecret(key, 'stripe_config', row.stripe)))
    throw new Error('Demo mode refuses stored live Stripe keys');
}
/** Integration entry point. Call demoBootCheck before ordinary auth/payment initialization.
 * Mount only the sandbox-create registration on the install origin before tenant resolution.
 */
export async function createDemoRuntime(options: {
  env?: NodeJS.ProcessEnv; installOrigin: string; clientIp?: ClientIpOptions; removeUploads(gymId: string): Promise<void>;
}) {
  const env = options.env ?? process.env, config = demoBootCheck(env);
  if (!config.enabled) { disableDemoRoutes(options.installOrigin, tenancyMode(env.TENANCY ?? 'single')); return undefined; }
  const key = parseEncryptionKey(env.APP_ENCRYPTION_KEY ?? '');
  await verifyDemoStoredKeys(key);
  // Delivery is configured by the outbox, so this mode requires no SMTP host.
  const authentication = authConfig({ ...env, AUTH_PASSWORD_LOGIN: 'off' }, true);
  const identities = createDemoIdentities({ config, authConfig: authentication, clock: defaultClock });
  const deletion = createGymDeleteService({ clock: defaultClock, removeUploads: options.removeUploads });
  const service = createDemoService({ config, key, clock: defaultClock, deletion, identities, seed: context => runSeeds(context, undefined, { env }) });
  configureDemoRoutes(service, { installOrigin: options.installOrigin, ...(options.clientIp ? { clientIp: options.clientIp } : {}) });
  configureGymDeletion(deletion);
  const t = createTranslator(locales.en ?? {});
  const emailFor = (gymId: string) => new OutboxEmail(gymId, defaultClock);
  return { service, registerCleanup: (queue: Parameters<typeof registerDemoCleanup>[0]) => registerDemoCleanup(queue, { config, service, clock: defaultClock }), authConfig: authentication, emailFor, skipSetup: true as const,
    async sendMagicLink(input: { email: string; url: string; gymId: string }) {
      const rendered = await renderDemoLogin(input.url, t);
      await emailFor(input.gymId).sendEmail({ to: input.email, ...rendered });
    },
  };
}
