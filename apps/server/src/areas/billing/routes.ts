// SPDX-License-Identifier: AGPL-3.0-only
import type { RouteRegistration } from '../../core/registry.js';
import { routes as part0 } from './catalog.routes.js';
import { routes as part1 } from './memberships.routes.js';
import { routes as part2 } from './invoicing/invoicing.routes.js';
import { routes as part3 } from './webhooks/inbox.routes.js';
import { routes as part4 } from './transitions/transitions.routes.js';
import { routes as part5 } from './runner/runner.routes.js';
import { routes as part6 } from './webhooks/handlers/handlers.routes.js';
import { routes as part7 } from './payments.routes.js';
import { routes as part8 } from './alerts/alerts.routes.js';
import { routes as part9 } from './kiosk-standing.routes.js';

export const routes: readonly RouteRegistration[] = [
  ...part0,
  ...part1,
  ...part2,
  ...part3,
  ...part4,
  ...part5,
  ...part6,
  ...part7,
  ...part8,
  ...part9,
];
