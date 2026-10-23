// SPDX-License-Identifier: AGPL-3.0-only
import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { systemDatabase, validateUuid, type Database } from '@plaingym/db/client';
import { authUser, authSession, authAccount, authVerification, authRateLimit } from '@plaingym/db';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { Auth, Session } from './index.js';
import { passwordLogin, type AuthConfig } from './config.js';
import { passwordAdapter } from './password.js';

export interface ResolvedAuthGym {
  readonly gymId: string;
  /** Canonical origin from trusted tenant configuration, never forwarded headers or login input. */
  readonly origin: string;
  /** Socket address or an address validated by the trusted-proxy integration. */
  readonly clientIp: string;
  /** Whether this gym can send email (its own SMTP or the install's). Omitted: the install's setting. */
  readonly smtpConfigured?: boolean;
}
export interface GoogleAuthExtension {
  readonly plugins?: BetterAuthPlugin[];
  readonly socialProviders: { google: { clientId: string; clientSecret: string } };
  /** Must bind and verify OAuth state to the resolved gym before dispatch. */
  beforeRequest(request: Request, gym: ResolvedAuthGym): Promise<boolean>;
}
export interface AuthServiceOptions {
  readonly config: AuthConfig;
  readonly database?: () => Database;
  readonly sendMagicLink?: (data: { email: string; url: string; gymId: string }) => Promise<void>;
  readonly magicLinkTtl?: number;
  readonly google?: GoogleAuthExtension;
  readonly rateLimit?: { window: number; max: number };
}
export const authEndpoints = [
  'POST /sign-in/email', 'POST /sign-in/magic-link', 'GET /magic-link/verify', 'GET /get-session', 'POST /sign-out',
] as const;

export function createAuthService(options: AuthServiceOptions) {
  const { config } = options;
  if (config.smtpConfigured && !options.sendMagicLink) throw new Error('Configured SMTP requires a magic-link sender');
  const database = options.database ?? systemDatabase;
  return {
    config,
    bind(gym: ResolvedAuthGym) {
      validateUuid(gym.gymId);
      const origin = new URL(gym.origin);
      if (origin.origin !== gym.origin || !['https:', 'http:'].includes(origin.protocol) || (config.production && origin.protocol !== 'https:')) throw new Error('Expected a canonical auth origin');
      if (!isIP(gym.clientIp)) throw new Error('Expected a trusted client IP');
      const smtpConfigured = gym.smtpConfigured ?? config.smtpConfigured;
      const passwordEnabled = gym.smtpConfigured === undefined ? config.passwordEnabled : passwordLogin(config, smtpConfigured);
      const magicLinkEnabled = Boolean(options.sendMagicLink) && (gym.smtpConfigured ?? true);
      const auth = betterAuth({
        secret: config.secret, baseURL: origin.origin, basePath: '/api/auth', trustedOrigins: [origin.origin],
        database: drizzleAdapter(database(), { provider: 'pg', schema: {
          user: authUser, session: authSession, account: authAccount, verification: authVerification, rateLimit: authRateLimit,
        }, transaction: true }),
        emailAndPassword: { enabled: passwordEnabled, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128, password: passwordAdapter },
        session: { additionalFields: { gymId: { type: 'string', required: true, input: false } }, cookieCache: { enabled: false } },
        account: { accountLinking: { enabled: true, trustedProviders: ['google'] } },
        ...(options.google ? { socialProviders: options.google.socialProviders } : {}),
        advanced: {
          // PostgreSQL/Drizzle supplies UUIDv7 record defaults. Declaring UUID
          // storage also keeps Better Auth's deterministic reservation IDs valid.
          database: { generateId: 'uuid' }, useSecureCookies: config.production,
          crossSubDomainCookies: { enabled: false },
          defaultCookieAttributes: { httpOnly: true, secure: config.production, sameSite: 'lax', path: '/' },
          ipAddress: { ipAddressHeaders: ['x-plaingym-client-ip'] },
        },
        databaseHooks: {
          user: { create: { before: async (user) => ({ data: { ...user, email: user.email.toLowerCase() } }) }, update: { before: async (user) => ({ data: { ...user, ...(user.email ? { email: user.email.toLowerCase() } : {}) } }) } },
          session: { create: { before: async (session) => ({ data: { ...session, gymId: gym.gymId } }) } },
        },
        rateLimit: { enabled: true, storage: 'database', window: 60, max: 100,
          customRules: { '/sign-in/email': options.rateLimit ?? { window: 60, max: 5 }, '/sign-in/magic-link': options.rateLimit ?? { window: 60, max: 5 }, '/magic-link/verify': options.rateLimit ?? { window: 60, max: 5 } } },
        plugins: [magicLink({
          expiresIn: options.magicLinkTtl ?? 300, storeToken: 'hashed', disableSignUp: true,
          generateToken: () => `${gym.gymId}.${randomBytes(32).toString('base64url')}`,
          sendMagicLink: async ({ email, url }) => {
            assertNoTransaction('auth.sendMagicLink');
            if (!options.sendMagicLink) throw new Error('Magic-link delivery is not configured');
            await options.sendMagicLink({ email: email.toLowerCase(), url, gymId: gym.gymId });
          },
        }), ...(options.google?.plugins ?? [])],
      });
      function headers(request: Request) {
        const result = new Headers(request.headers);
        for (const key of [...result.keys()]) if (/^(?:forwarded$|x-forwarded-|x-real-ip$|cf-connecting-ip$|x-plaingym-client-ip$|host$)/i.test(key)) result.delete(key);
        result.set('x-plaingym-client-ip', gym.clientIp);
        return result;
      }
      async function readSession(request: Request) {
        assertNoTransaction('auth.getSession');
        return auth.api.getSession({ headers: headers(request), query: { disableCookieCache: true, disableRefresh: true } });
      }
      const adapter: Auth = {
        async getSession(request): Promise<Session | null> {
          const session = await readSession(request);
          return session?.session.gymId === gym.gymId ? { userId: session.user.id } : null;
        },
      };
      return {
        ...adapter,
        /** Internal provisioning entry point; delivery always follows the owner commit. */
        async sendLoginLink(email: string): Promise<void> {
          assertNoTransaction('auth.sendLoginLink');
          if (!options.sendMagicLink) throw new Error('Magic-link delivery is not configured');
          await auth.api.signInMagicLink({
            headers: { origin: origin.origin, 'x-plaingym-client-ip': gym.clientIp },
            body: { email: email.trim().toLowerCase(), callbackURL: new URL('/login', origin).href },
          });
        },
        async checkedSession(request: Request): Promise<Session | null> {
          const session = await readSession(request);
          if (session && session.session.gymId !== gym.gymId) throw new Error('session_gym_mismatch');
          return session ? { userId: session.user.id } : null;
        },
        async handler(request: Request): Promise<Response> {
          assertNoTransaction('auth.handler');
          const url = new URL(request.url);
          // A TLS proxy may forward over HTTP; the resolved gym supplies the origin below.
          if (!url.pathname.startsWith('/api/auth/')) return new Response(null, { status: 404 });
          const path = url.pathname.slice('/api/auth'.length);
          const key = `${request.method} ${path}`;
          const googleEndpoint = Boolean(options.google && (key === 'POST /sign-in/social' || key === 'GET /callback/google'));
          if (!authEndpoints.some((endpoint) => endpoint === key) && !googleEndpoint) return new Response(null, { status: 404 });
          if (path === '/sign-in/email' && !passwordEnabled) return new Response(null, { status: 404 });
          if ((path === '/sign-in/magic-link' || path === '/magic-link/verify') && !magicLinkEnabled) return new Response(null, { status: 404 });
          const session = await readSession(request);
          if (session && session.session.gymId !== gym.gymId) return Response.json({ error: 'session_gym_mismatch' }, { status: 403 });
          if (request.method === 'POST') {
            if (request.headers.get('origin') !== origin.origin || request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ error: 'invalid_origin' }, { status: 403 });
          }
          if (googleEndpoint && !await options.google!.beforeRequest(request, gym)) return new Response(null, { status: 403 });
          if (path === '/magic-link/verify') {
            if (!url.searchParams.get('token')?.startsWith(`${gym.gymId}.`)) return Response.json({ error: 'invalid_token_gym' }, { status: 403 });
          }
          // Reconstruct callbacks and origin from the resolved gym. Never propagate caller-supplied redirects.
          const safeUrl = new URL('/api/auth' + path, origin);
          if (path === '/magic-link/verify') safeUrl.searchParams.set('token', url.searchParams.get('token')!);
          for (const name of ['callbackURL', 'newUserCallbackURL', 'errorCallbackURL']) if (path === '/magic-link/verify') safeUrl.searchParams.set(name, new URL(name === 'errorCallbackURL' ? '/login' : '/admin', origin).href);
          let body: string | undefined;
          if (request.method === 'POST') {
            let input: unknown;
            try { input = await request.json(); } catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
            if (typeof input !== 'object' || input === null) return new Response(null, { status: 400 });
            const fields = input as Record<string, unknown>;
            body = JSON.stringify({ ...fields, ...(typeof fields.email === 'string' ? { email: fields.email.toLowerCase() } : {}),
              callbackURL: new URL('/admin', origin).href, newUserCallbackURL: new URL('/admin', origin).href, errorCallbackURL: new URL('/login', origin).href });
          }
          if (googleEndpoint) {
            // The extension owns provider state and callback parameters after validating the gym binding.
            safeUrl.search = url.search;
          }
          const response = await auth.handler(new Request(safeUrl, { method: request.method, headers: headers(request), ...(body ? { body } : {}) }));
          response.headers.set('cache-control', 'no-store');
          if (response.headers.get('content-type')?.includes('application/json') && response.ok) {
            const value: unknown = await response.json();
            if (value && typeof value === 'object') {
              const output = value as Record<string, unknown>;
              delete output.token;
              if (output.session && typeof output.session === 'object') delete (output.session as Record<string, unknown>).token;
            }
            return Response.json(value, { status: response.status, headers: response.headers });
          }
          return response;
        },
      };
    },
  };
}
export type AuthService = ReturnType<typeof createAuthService>;
