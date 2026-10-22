// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { jobs as part0 } from './auth.jobs.js';
import { jobs as part1 } from './access.jobs.js';
import { jobs as part2 } from './bookings.jobs.js';
import { jobs as part3 } from './schedule.jobs.js';
import { jobs as part4 } from './checkin.jobs.js';
import { jobs as part5 } from './progress.jobs.js';
import { jobs as part6 } from './billing.jobs.js';
import { jobs as part7 } from './waivers.jobs.js';
import { jobs as part8 } from './household.jobs.js';

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
];
