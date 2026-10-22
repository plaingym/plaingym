// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { jobs as part0 } from './backups.jobs.js';
import { jobs as part1 } from './restore.jobs.js';
import { jobs as part2 } from './status.jobs.js';
import { jobs as part3 } from './stripe.jobs.js';
import { jobs as part4 } from './charge-run.jobs.js';
import { jobs as part5 } from './auto-update.jobs.js';
import { jobs as part6 } from './updates.jobs.js';

export const jobs: readonly JobRegistration[] = [
  ...part0,
  ...part1,
  ...part2,
  ...part3,
  ...part4,
  ...part5,
  ...part6,
];
