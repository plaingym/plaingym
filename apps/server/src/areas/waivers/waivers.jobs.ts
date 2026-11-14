// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import type { WaiverOptions } from './waivers.js';
import { sweepSignatureImages } from './signature-images.js';

export const SIGNATURE_IMAGE_SWEEP_JOB = 'waivers.signature-images.sweep';
const cron = '20 3 * * *';
type SweepOptions = Pick<WaiverOptions, 'uploadsFor' | 'scope'>;
async function sweep(options: SweepOptions, gymId: string, now: Date) {
  await sweepSignatureImages({ gymId, uploads: await options.uploadsFor(gymId), now, ...(options.scope ? { scope: options.scope } : {}) });
}
// A gym's whole waiver folder is listed and checked, so the sweep runs in the batch lane.
export function createWaiverImageSweepJobs(options: SweepOptions): JobRegistration[] {
  return [{ id: SIGNATURE_IMAGE_SWEEP_JOB, cron, lane: 'batch', async handler(_payload, context) {
    await sweep(options, context.gymId, context.clock.now());
  } }];
}
let configured: SweepOptions | undefined;
export function configureWaiverImageSweep(options: SweepOptions) { configured = options; }
export const jobs: readonly JobRegistration[] = [{ id: SIGNATURE_IMAGE_SWEEP_JOB, cron, lane: 'batch', async handler(_payload, context) {
  if (!configured) throw new Error('Waiver image sweep is not configured');
  await sweep(configured, context.gymId, context.clock.now());
} }];
