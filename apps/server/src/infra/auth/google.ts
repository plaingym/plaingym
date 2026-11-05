// SPDX-License-Identifier: AGPL-3.0-only
import type { BetterAuthPlugin } from 'better-auth';
import { addOAuthServerContext, createAuthMiddleware } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { systemDatabase, type Database } from '@plaingym/db/client';
import { authVerification } from '@plaingym/db';
import { googleCallbackPath } from '@plaingym/shared/contracts';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { GoogleAuthExtension, ResolvedAuthGym } from './service.js';

/** The install's Google OAuth client (a "Web application" client in Google Cloud). */
export interface GoogleCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}
export { googleCallbackPath };
/** Where the sign-in hook writes the issuing gym into the OAuth state; Better Auth keeps server context apart from client data. */
export const googleStateGymKey = 'plaingymGymId';

/**
 * The Google client from the instance's configuration: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, both or neither.
 * When set, it wins in either tenancy mode; otherwise a single-gym owner may store the gym's own client
 * (`areas/settings/google-login.ts`). Demo mode ignores them: sandboxes sign in with their one-click logins.
 */
export function googleFromEnvironment(env: NodeJS.ProcessEnv = process.env): GoogleCredentials | null {
  if (env.DEMO_MODE === 'true') return null;
  const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? '', clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) throw new Error('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither');
  if (/\s/.test(clientId) || /\s/.test(clientSecret) || clientId.length > 512 || clientSecret.length > 512) throw new Error('Invalid Google OAuth credentials');
  return { clientId, clientSecret };
}

/** Writes the issuing gym into the state of every Google sign-in this gym's auth instance starts. */
function gymStatePlugin(gym: ResolvedAuthGym): BetterAuthPlugin {
  return {
    id: 'plaingym-google-gym-state',
    hooks: { before: [{
      matcher: (context) => context.path === '/sign-in/social',
      handler: createAuthMiddleware(async () => { await addOAuthServerContext({ [googleStateGymKey]: gym.gymId }); }),
    }] },
  };
}

const stateShape = /^[A-Za-z0-9_-]{16,128}$/;
/** The gym an unexpired OAuth state was issued for, from the state row Better Auth stores; null for anything else. */
async function stateGym(database: Database, state: string, now: Date): Promise<string | null> {
  const [row] = await database.select({ value: authVerification.value, expiresAt: authVerification.expiresAt })
    .from(authVerification).where(eq(authVerification.identifier, `auth-state:${state}`)).limit(1);
  if (!row || row.expiresAt <= now) return null;
  let value: unknown;
  try { value = JSON.parse(row.value); } catch { return null; }
  const context = value && typeof value === 'object' ? (value as { serverContext?: unknown }).serverContext : undefined;
  const gymId = context && typeof context === 'object' ? (context as Record<string, unknown>)[googleStateGymKey] : undefined;
  return typeof gymId === 'string' ? gymId : null;
}

/**
 * Google sign-in for staff and members. `credentials` is one client for every gym, or a lookup of each gym's current
 * client (null: Google sign-in is off for that gym), called on each Google request. The sign-in accepts only
 * `{ "provider": "google" }` (no ID-token sign-in, scopes or extra state), and the callback runs only for a state this gym
 * issued: a state from another gym, an unknown or expired state, or several states are refused before Better Auth reads them.
 */
export function createGoogleAuthExtension(options: {
  credentials: GoogleCredentials | ((gymId: string) => Promise<GoogleCredentials | null>);
  database?: () => Database;
  now?: () => Date;
}): GoogleAuthExtension {
  const database = options.database ?? systemDatabase, now = options.now ?? (() => new Date());
  const lookup = options.credentials;
  return {
    async credentials(gymId) {
      assertNoTransaction('auth.google.credentials');
      return typeof lookup === 'function' ? lookup(gymId) : lookup;
    },
    plugins: (gym) => [gymStatePlugin(gym)],
    async beforeRequest(request, gym) {
      assertNoTransaction('auth.google.beforeRequest');
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/api/auth/sign-in/social') {
        if (url.search) return false;
        let body: unknown;
        try { body = await request.clone().json(); } catch { return false; }
        return typeof body === 'object' && body !== null && !Array.isArray(body)
          && Object.keys(body).length === 1 && (body as Record<string, unknown>).provider === 'google';
      }
      if (request.method === 'GET' && url.pathname === googleCallbackPath) {
        const states = url.searchParams.getAll('state');
        if (states.length !== 1 || !stateShape.test(states[0]!)) return false;
        return await stateGym(database(), states[0]!, now()) === gym.gymId;
      }
      return false;
    },
  };
}
