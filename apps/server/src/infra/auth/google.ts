// SPDX-License-Identifier: AGPL-3.0-only
import type { BetterAuthPlugin } from 'better-auth';
import { addOAuthServerContext, createAuthMiddleware } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { systemDatabase, type Database } from '@plaingym/db/client';
import { authVerification } from '@plaingym/db';
import { googleCallbackPath, type GoogleClientCheck, type GoogleEnvironmentProblem } from '@plaingym/shared/contracts';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { logError } from '../../core/log.js';
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
 * What is wrong with the instance's `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, or null when they are usable or both
 * unset (each is trimmed first; Compose passes an unset value as empty). Demo mode ignores them, so has no problem.
 */
export function googleEnvironmentProblem(env: NodeJS.ProcessEnv = process.env): GoogleEnvironmentProblem | null {
  if (env.DEMO_MODE === 'true') return null;
  const values = { GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID?.trim() ?? '', GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET?.trim() ?? '' };
  if (!values.GOOGLE_CLIENT_ID && !values.GOOGLE_CLIENT_SECRET) return null;
  for (const variable of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const) {
    const value = values[variable];
    if (!value) return { variable, reason: 'missing' };
    if (/\s/.test(value)) return { variable, reason: 'whitespace' };
    if (value.length > 512) return { variable, reason: 'too_long' };
  }
  return null;
}
const problemText: Record<GoogleEnvironmentProblem['reason'], string> = {
  missing: 'is not set, but the other Google variable is: set both, or neither',
  whitespace: 'contains a space or line break',
  too_long: 'is longer than 512 characters',
};
/** The log line's text for a problem: names the variable and the reason, never its value. */
export const googleEnvironmentProblemMessage = (problem: GoogleEnvironmentProblem) =>
  `${problem.variable} ${problemText[problem.reason]}; Google sign-in from the server configuration is off`;
const logged = new Set<string>();
/**
 * The Google client from the instance's configuration: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, both or neither.
 * When set, it wins in either tenancy mode; otherwise a single-gym owner may store the gym's own client
 * (`areas/settings/google-login.ts`). Demo mode ignores them: sandboxes sign in with their one-click logins.
 * Malformed values never stop the app: they are ignored (as if unset), logged once per process naming the variable
 * and the reason, and reported on the Health page and in Settings → Google sign-in (`googleEnvironmentProblem`).
 */
export function googleFromEnvironment(env: NodeJS.ProcessEnv = process.env): GoogleCredentials | null {
  if (env.DEMO_MODE === 'true') return null;
  const problem = googleEnvironmentProblem(env);
  if (problem) {
    const line = googleEnvironmentProblemMessage(problem);
    if (!logged.has(line)) { logged.add(line); logError('auth.google_environment_invalid', { variable: problem.variable, reason: problem.reason, message: line }); }
    return null;
  }
  const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? '', clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Google's OAuth token endpoint, which the client check asks. */
export const googleTokenEndpoint = 'https://oauth2.googleapis.com/token';
/** A code Google never issued: the check exchanges it, so no sign-in or token can result. */
const madeUpCode = 'plaingym-client-check';
/**
 * Asks Google's token endpoint whether it knows a client ID and secret, by exchanging a made-up authorization code:
 * `invalid_grant` means it accepted the client (and refused only the code), `invalid_client` means it didn't
 * (`rejected`), and any other answer, a timeout or a network failure is `unknown`. Call it outside any transaction.
 * The secret goes only to Google, in the request body; nothing here logs or returns it.
 */
export async function checkGoogleClient(credentials: GoogleCredentials, options: {
  /** The gym's redirect URI (origin + `googleCallbackPath`), which the token request names as a sign-in would. */
  redirectUri: string;
  fetch?: typeof fetch; timeoutMs?: number;
}): Promise<GoogleClientCheck | 'rejected'> {
  assertNoTransaction('auth.google.checkClient');
  const fetcher = options.fetch ?? fetch;
  try {
    const response = await fetcher(googleTokenEndpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: madeUpCode, redirect_uri: options.redirectUri,
        client_id: credentials.clientId, client_secret: credentials.clientSecret }),
    });
    const text = (await response.text()).slice(0, 16_384);
    let error: unknown;
    try { error = (JSON.parse(text) as { error?: unknown } | null)?.error; } catch { return 'unknown'; }
    return error === 'invalid_grant' ? 'accepted' : error === 'invalid_client' ? 'rejected' : 'unknown';
  } catch { return 'unknown'; }
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
