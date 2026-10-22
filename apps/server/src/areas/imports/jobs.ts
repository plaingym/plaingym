// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { jobs as part0 } from './pipeline.jobs.js';
import { jobs as part1 } from './export.jobs.js';
import { jobs as part2 } from './mappers/people.jobs.js';
import { jobs as part3 } from './mappers/mat.jobs.js';
import { jobs as part4 } from './mappers/memberships.jobs.js';

export const jobs: readonly JobRegistration[] = [...part0, ...part1, ...part2, ...part3, ...part4];
