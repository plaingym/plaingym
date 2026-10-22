// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { jobs as part0 } from './schedule.jobs.js';

export const jobs: readonly JobRegistration[] = [...part0];
