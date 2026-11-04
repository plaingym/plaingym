// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'hono';
import { AppError } from '@plaingym/shared';
import { integrationsContracts } from '@plaingym/shared/contracts';
import type { RequestEnvironment } from '../../core/context.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { route, type RouteRegistration } from '../../core/registry.js';
import { integrationsService, type IntegrationsService } from './integrations.js';

/** The signed-in owner of the resolved gym; `route()` has already checked `integrations.manage`. */
function owner(c: Context<RequestEnvironment>): MutationContext & { actor: { kind: 'user'; userId: string } } {
  const { gym, principal } = c.get('context');
  if (principal.kind !== 'staff' || principal.gymId !== gym.gymId) throw new AppError('not_found', 'Gym not found');
  return { gymId: gym.gymId, actor: { kind: 'user', userId: principal.userId } };
}
const response = <T>(schema: T, description: string) => ({ 200: { description, content: { 'application/json': { schema } } } });
const body = <T>(schema: T) => ({ body: { required: true as const, content: { 'application/json': { schema } } } });

/** Tests pass a service; otherwise the routes use the one the runtime configures. */
export function createIntegrationsRoutes(service?: IntegrationsService): RouteRegistration[] {
  const current = () => service ?? integrationsService();
  const { get, saveEmail, removeEmail, saveStripe, createBackupKey, confirmBackupKey, getGoogle, saveGoogle, removeGoogle } = integrationsContracts;
  return [
    route({ ...get, responses: response(get.response, 'Email, payments and backups') }, async (c) => {
      const context = owner(c);
      return c.json({ data: await current().get(context.gymId, context.actor.userId) }, 200);
    }),
    route({ ...saveEmail, request: body(saveEmail.body), responses: response(saveEmail.response, 'The test result and the integrations') },
      async (c) => c.json({ data: await current().saveEmail(owner(c), c.req.valid('json')) }, 200)),
    route({ ...removeEmail, request: body(removeEmail.body), responses: response(removeEmail.response, 'The integrations without the gym’s own email settings') },
      async (c) => c.json({ data: await current().removeEmail(owner(c), c.req.valid('json')) }, 200)),
    route({ ...saveStripe, request: body(saveStripe.body), responses: response(saveStripe.response, 'The integrations with the new Stripe key') },
      async (c) => c.json({ data: await current().saveStripe(owner(c), c.req.valid('json')) }, 200)),
    route({ ...createBackupKey, request: body(createBackupKey.body), responses: response(createBackupKey.response, 'The new backup key, shown once') },
      async (c) => c.json({ data: await current().createBackupKey(owner(c), c.req.valid('json')) }, 200)),
    route({ ...confirmBackupKey, request: body(confirmBackupKey.body), responses: response(confirmBackupKey.response, 'The integrations with the confirmed backup key') },
      async (c) => c.json({ data: await current().confirmBackupKey(owner(c), c.req.valid('json')) }, 200)),
    route({ ...getGoogle, responses: response(getGoogle.response, 'Google sign-in for this gym, never the client secret') }, async (c) => {
      const context = owner(c);
      return c.json({ data: await current().getGoogle(context.gymId, context.actor.userId) }, 200);
    }),
    route({ ...saveGoogle, request: body(saveGoogle.body), responses: response(saveGoogle.response, 'Google sign-in with the stored client') },
      async (c) => c.json({ data: await current().saveGoogle(owner(c), c.req.valid('json')) }, 200)),
    route({ ...removeGoogle, request: body(removeGoogle.body), responses: response(removeGoogle.response, 'Google sign-in without a stored client') },
      async (c) => c.json({ data: await current().removeGoogle(owner(c), c.req.valid('json')) }, 200)),
  ];
}
export const routes: readonly RouteRegistration[] = createIntegrationsRoutes();
