// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { jobs as part0 } from './setup.jobs.js';
import { jobs as part1 } from './import-step.jobs.js';
import { jobs as part2 } from './stripe-step.jobs.js';

export const jobs: readonly JobRegistration[] = [...part0, ...part1, ...part2];
