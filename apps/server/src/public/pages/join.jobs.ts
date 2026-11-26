// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { JobRegistration } from '../../core/registry.js';
import { AppError } from '@plaingym/shared';
import { logWarn } from '../../core/log.js';
import { joinCleanupJob, type createJoinCleanup } from './join.cleanup.js';

/** Sends a passwordless join's sign-in link after the request answers, so every address answers after the same work. */
export const joinSignInJob = 'public.join.sign_in';
/** The sign-in job's attempts: a delivery that fails them all is logged. */
export const joinSignInAttempts = 5;
// Unknown keys are ignored, so a release rolled back to still runs a sign-in a newer one queued.
const signInPayload = z.object({ householdId: z.uuid() });
let cleanup: ReturnType<typeof createJoinCleanup> | undefined;
let signIn: ((gymId: string, householdId: string) => Promise<void>) | undefined;
export function configureJoinCleanup(service: ReturnType<typeof createJoinCleanup>) { cleanup = service; }
export function configureJoinSignIn(send: (gymId: string, householdId: string) => Promise<void>) { signIn = send; }
export const jobs: readonly JobRegistration[] = [{ id: joinCleanupJob, cron: '29 3 * * *', lane: 'batch', async handler(_payload, context) {
  if (!cleanup) throw new AppError('unavailable', 'Join cleanup is not configured');
  await cleanup.run(context.gymId, context.timezone);
} }, { id: joinSignInJob, async handler(payload, context) {
  const { householdId } = signInPayload.parse(payload);
  if (!signIn) throw new AppError('unavailable', 'Join sign-in is not configured');
  try { await signIn(context.gymId, householdId); }
  catch (error) {
    if (context.attempt >= joinSignInAttempts) logWarn('public.join.sign_in_failed', { gymId: context.gymId, householdId, attempt: context.attempt });
    throw error;
  }
} }];
