// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { jobs as part0 } from './devices.jobs.js';
import { jobs as part1 } from './standing/standing.jobs.js';
import { jobs as part2 } from './qr.jobs.js';

export const jobs: readonly JobRegistration[] = [...part0, ...part1, ...part2];
