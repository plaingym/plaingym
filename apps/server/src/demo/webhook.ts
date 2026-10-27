// SPDX-License-Identifier: AGPL-3.0-only
import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from '../core/context.js';
import { errorHandler } from '../core/errors.js';
import { createWebhookInboxRoutes } from '../areas/billing/webhooks/inbox.routes.js';
import type { WebhookInbox } from '../areas/billing/webhooks/inbox.js';

/** Use the app's install middleware slot, after body limits and before tenant/session resolution. */
export function demoWebhookMiddleware(options: {
  configured: boolean;
  inbox: Pick<WebhookInbox, 'receive'>;
  demoGyms: () => Promise<readonly { gymId: string }[]>;
  restoreGate?: MiddlewareHandler<RequestEnvironment>;
}): MiddlewareHandler<RequestEnvironment> {
  return async (context, next) => {
    const dispatch = async () => {
      if (!options.configured || context.req.method !== 'POST' || context.req.path !== '/webhooks/stripe') return next();
      const gyms = await options.demoGyms();
      // A configured install with no active destination acknowledges and discards.
      if (!gyms.length) { context.res = context.json({ received: true }); return; }
      const app = new OpenAPIHono<RequestEnvironment>();
      app.onError(errorHandler);
      for (const entry of createWebhookInboxRoutes(options.inbox, { demoGyms: async () => gyms })) {
        entry.mount(app, permission => async (_context, proceed) => {
          if (permission.kind !== 'public') throw new Error('Demo webhook must be public');
          await proceed();
        });
      }
      context.res = await app.fetch(context.req.raw);
    };
    if (options.restoreGate) return options.restoreGate(context, dispatch);
    else await dispatch();
  };
}
