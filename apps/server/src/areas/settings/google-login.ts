// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { forGym, gyms } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { googleCallbackPath, googleClientValueSchema, type GoogleClientCheck } from '@plaingym/shared/contracts';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';
import { readStoredSecret } from './unreadable-secret.js';
import { checkGoogleClient, googleEnvironmentProblem, googleFromEnvironment, type GoogleCredentials } from '../../infra/auth/google.js';

/** The gym's own Google OAuth client, stored encrypted in `gyms.google_config_encrypted` (secret class `google_config`). */
export const storedGoogleSchema = z.strictObject({ clientId: googleClientValueSchema, clientSecret: googleClientValueSchema });
// A newer release may store more keys. This one ignores them, and a save replaces the whole value from the form.
const readGoogleSchema = z.object(storedGoogleSchema.shape);

export function encryptGoogleConfig(key: Buffer, gymId: string, credentials: GoogleCredentials): string {
  return encryptSecret(key, { secretClass: 'google_config', owner: gymId }, JSON.stringify(storedGoogleSchema.parse(credentials)));
}
/** The stored client, or null when there is none or it can't be read (logged as `logError` does: never the message). */
export function readGoogleConfig(key: Buffer, value: string | null, gymId: string): GoogleCredentials | null {
  return readStoredSecret(key, 'google_config', gymId, value, () =>
    readGoogleSchema.parse(JSON.parse(decryptSecret(key, { secretClass: 'google_config', owner: gymId }, value!))));
}

/** Asks Google about a client before it is saved; tests replace it with a faked token endpoint. */
export type CheckGoogle = (credentials: GoogleCredentials, redirectUri: string) => Promise<GoogleClientCheck | 'rejected'>;
const defaultCheck: CheckGoogle = (credentials, redirectUri) => checkGoogleClient(credentials, { redirectUri });
/**
 * The setup wizard's and Settings' check of a client about to be saved, outside any transaction: a client Google refused
 * is a field error (`google_rejected`), anything else is saved with the check's result for the reply.
 */
export async function requireGoogleClient(credentials: GoogleCredentials, origin: string, check: CheckGoogle = defaultCheck): Promise<GoogleClientCheck> {
  const result = await check(credentials, origin + googleCallbackPath);
  if (result === 'rejected')
    throw new AppError('invalid_request', 'Google did not accept this client ID and secret', { reason: ['google_rejected'] });
  return result;
}

export interface GoogleClientOptions {
  /** `APP_ENCRYPTION_KEY`, which the stored client is encrypted with. */
  key: Buffer;
  /** The instance's configuration: its `GOOGLE_*` variables and `DEMO_MODE`. */
  env: NodeJS.ProcessEnv;
  tenancy: 'single' | 'multi';
  scope?: typeof forGym;
}
/**
 * Which Google client a gym signs in with. The instance's `GOOGLE_*` variables win in either tenancy mode; otherwise a
 * single-gym install uses the client the owner stored, and a multi-gym install has none (the stored column is ignored,
 * as gym-entered credentials are for email and payments there). Demo mode has none. Read on every call, so a saved
 * or removed client takes effect on the next sign-in without a restart.
 */
export function createGoogleClientResolver(options: GoogleClientOptions) {
  const scope = options.scope ?? forGym;
  const demo = options.env.DEMO_MODE === 'true';
  const install = googleFromEnvironment(options.env);
  /** Whether the gym may store its own client: single-gym, not a demo, and not set by the install's configuration. */
  const editable = options.tenancy === 'single' && !demo && install === null;
  async function stored(gymId: string): Promise<GoogleCredentials | null> {
    const [row] = await scope(gymId, (tx) => tx.select({ google: gyms.googleConfig }).from(gyms).where(eq(gyms.id, gymId)));
    return readGoogleConfig(options.key, row?.google ?? null, gymId);
  }
  return {
    editable,
    /** The install's client when set, which then wins over a stored one. */
    install,
    /** Why the install's `GOOGLE_*` variables were ignored, when they are malformed (null otherwise). */
    problem: googleEnvironmentProblem(options.env),
    async credentials(gymId: string): Promise<GoogleCredentials | null> {
      if (install) return install;
      return editable ? stored(gymId) : null;
    },
  };
}
export type GoogleClientResolver = ReturnType<typeof createGoogleClientResolver>;
