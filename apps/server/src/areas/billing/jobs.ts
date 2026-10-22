// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { jobs as part0 } from './catalog.jobs.js';
import { jobs as part1 } from './memberships.jobs.js';
import { jobs as part2 } from './invoicing/invoicing.jobs.js';
import { jobs as part3 } from './webhooks/inbox.jobs.js';
import { jobs as part4 } from './transitions/transitions.jobs.js';
import { jobs as part5 } from './runner/runner.jobs.js';
import { jobs as part6 } from './webhooks/handlers/handlers.jobs.js';
import { jobs as part7 } from './payments.jobs.js';
import { jobs as part8 } from './alerts/alerts.jobs.js';
import { jobs as part9 } from './kiosk-standing.jobs.js';

export const jobs: readonly JobRegistration[] = [
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
