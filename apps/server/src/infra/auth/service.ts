// SPDX-License-Identifier: AGPL-3.0-only
import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { jsx } from 'hono/jsx/jsx-runtime';
import { createTranslator, type Translator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { reportedPolicy, reportingEndpoints } from '../../core/csp.js';
import { scopedDatabase, systemDatabase, validateUuid, type Database } from '@plaingym/db/client';
import { authUser, authSession, authAccount, authVerification, authRateLimit, householdUsers, staffRoles } from '@plaingym/db';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { portalClaimCodeSchema } from '@plaingym/shared/contracts';
import type { Auth, Session } from './index.js';
import { passwordLogin, type AuthConfig } from './config.js';
import { passwordAdapter } from './password.js';
import { emailServiceFailure } from '../email/failure.js';
import { logWarn } from '../../core/log.js';
import { accountLimitedPaths, reserveAccountAttempt, releaseAccountAttempt, gymAddressStorage, signInLimits, loginLinkCeiling, reserveLoginLinkCeiling,
  type AccountReservation, type SignInRule } from './account-limit.js';

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
  /** Plugins for one gym's auth instance, such as the hook that writes that gym into the OAuth state. */
  plugins?(gym: ResolvedAuthGym): BetterAuthPlugin[];
  /**
   * The OAuth client this gym signs in with now, or null when Google sign-in is off for it. Looked up on each Google
   * request, outside any transaction, so a client saved or removed while the server runs applies to the next sign-in.
   */
  credentials(gymId: string): Promise<{ clientId: string; clientSecret: string } | null>;
  /** Must bind and verify OAuth state to the resolved gym before dispatch. */
  beforeRequest(request: Request, gym: ResolvedAuthGym): Promise<boolean>;
}
/** Google sign-in stores no provider tokens: login needs none, and a backup then holds no Google credentials of a user. */
const oauthTokenFields = ['accessToken', 'refreshToken', 'idToken'] as const;
function withoutOAuthTokens<T extends Record<string, unknown>>(account: T, always: boolean): T {
  const result: Record<string, unknown> = { ...account };
  for (const field of oauthTokenFields) if (always || result[field] != null) result[field] = null;
  return result as T;
}
export interface AuthServiceOptions {
  readonly config: AuthConfig;
  readonly database?: () => Database;
  readonly sendMagicLink?: (data: { email: string; url: string; gymId: string }) => Promise<void>;
  readonly magicLinkTtl?: number;
  readonly google?: GoogleAuthExtension;
  /** Each sign-in endpoint's limit per client address (default `signInLimits.address`). */
  readonly rateLimit?: SignInRule;
  /** Password and login-link sign-in's limit per account (default `signInLimits.account`). */
  readonly accountRateLimit?: SignInRule;
  /** Login links a gym sends to addresses with no staff role or household login there, per window (default `loginLinkCeiling`). */
  readonly loginLinkCeiling?: SignInRule;
  /** Epoch milliseconds for the per-account windows and the remembered send failure (default `Date.now`). */
  readonly now?: () => number;
  /** Waits before a login link the ceiling dropped answers, so it takes about as long as a sent one (default `setTimeout` from `node:timers/promises`). */
  readonly pause?: (milliseconds: number) => Promise<void>;
  /** A monotonic millisecond reading that times the gym's real login-link sends (default `performance.now`). */
  readonly elapsed?: () => number;
}
/** The longest a login link the ceiling dropped waits before it answers. */
export const loginLinkAnswerWaitMs = 2000;
/** How long after a gym's latest real login-link send failed a dropped one still answers with the same failure. */
export const loginLinkFailureMemoryMs = 5 * 60_000;
/** Per gym, the epoch millisecond its logged login-link ceiling window ends, so a full window logs once per process. */
const ceilingLogged = new Map<string, number>();
/** The only post-login destination besides the admin: completing a portal claim the user proved by email. */
export const portalClaimCallbackPath = '/portal/claim';
/**
 * A sign-in link request answers 503 with this code when the gym's sending service failed (`emailServiceFailure`).
 * The web sign-in page (`apps/web/src/routes/login.tsx`) and the setup wizard (`apps/web/src/features/setup/wizard.tsx`,
 * through `features/setup/api.ts`) compare this exact literal, so change them together.
 */
export const emailUnavailableCode = 'EMAIL_UNAVAILABLE';
const validClaimCode = (code: string) => portalClaimCodeSchema.safeParse(code).success;
function portalClaimCallback(value: string | null, origin: URL): string | null {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const keys = [...url.searchParams.keys()];
  if (url.origin !== origin.origin || url.pathname !== portalClaimCallbackPath || url.hash || keys.length !== 1 || keys[0] !== 'claim') return null;
  const code = url.searchParams.get('claim')!;
  return validClaimCode(code) ? new URL(portalClaimCallbackPath + '?claim=' + code, origin).href : null;
}
/**
 * How a login link's token is stored: SHA-256, base64url without padding, the form of Better Auth's own `hashed` option,
 * so links already sent keep working. Owning it lets `handler` find a link's row without consuming it.
 */
const linkTokenHash = (token: string) => createHash('sha256').update(token).digest('base64url');
/** Where a browser signed in as another login completes a login link it chose to follow. */
export const loginSwitchPath = '/magic-link/switch';
const authText = createTranslator(locales.en ?? {});
const switchPageStyle = 'body{margin:0;padding:1.5rem 1rem;font-family:system-ui,sans-serif;line-height:1.5}'
  + 'main{max-width:28rem;margin:0 auto}h1{font-size:1.5rem;line-height:1.25;margin:0 0 1rem}p{overflow-wrap:anywhere}'
  + '.action{display:block;box-sizing:border-box;width:100%;min-height:44px;margin-top:.75rem;padding:.625rem 1rem;border-radius:.5rem;'
  + 'font:inherit;text-align:center;overflow-wrap:anywhere;cursor:pointer}'
  + 'button.action{border:0;background:#1d4ed8;color:#fff}a.action{border:1px solid;color:inherit;text-decoration:none}';
/**
 * The switch page's URL holds the token, so a request from it names only the origin. Not `no-referrer`: under that policy
 * a browser sends `Origin: null` with the form's POST (Fetch, "append a request Origin header"), which the origin check refuses.
 */
const switchReferrerPolicy = 'strict-origin';
/**
 * The page a browser signed in as `current` gets for a login link to `next`. It has no script; its form posts the link's
 * token to `loginSwitchPath`, and its other choice leaves the browser as it is. The renderer escapes every value.
 */
export function loginSwitchPage(text: Translator, page: { current: string; next: string; token: string; callbackURL: string | null }) {
  const values = { current: page.current, next: page.next };
  return jsx('html', { lang: 'en', children: [
    jsx('head', { children: [jsx('meta', { charset: 'utf-8' }), jsx('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      jsx('meta', { name: 'color-scheme', content: 'light dark' }), jsx('meta', { name: 'referrer', content: switchReferrerPolicy }),
      jsx('title', { children: text('staff/auth:switchTitle') }), jsx('style', { children: switchPageStyle })] }),
    jsx('body', { children: jsx('main', { children: [
      jsx('h1', { children: text('staff/auth:switchTitle') }), jsx('p', { children: text('staff/auth:switchDescription', values) }),
      jsx('form', { method: 'post', action: '/api/auth' + loginSwitchPath, children: [
        jsx('input', { type: 'hidden', name: 'token', value: page.token }),
        ...(page.callbackURL === null ? [] : [jsx('input', { type: 'hidden', name: 'callbackURL', value: page.callbackURL })]),
        jsx('button', { type: 'submit', class: 'action', children: text('staff/auth:switchContinue', values) }),
      ] }),
      jsx('a', { href: '/', class: 'action', children: text('staff/auth:switchStay', values) }),
    ] }) }),
  ] });
}
/** The confirmation page as a response: never cached or framed, referring by origin only, and allowed no script. */
function loginSwitchResponse(page: Parameters<typeof loginSwitchPage>[1]): Response {
  return new Response('<!doctype html>' + loginSwitchPage(authText, page).toString(), { status: 200, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': switchReferrerPolicy,
    'content-security-policy': reportedPolicy(["default-src 'none'", "style-src 'unsafe-inline'", "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'"]),
    'reporting-endpoints': reportingEndpoints,
  } });
}
/** Every answer Better Auth gives through `handler`: never cached, and a refusal carries the standard `Retry-After` too. */
function forwardedAnswer(response: Response): Response {
  response.headers.set('cache-control', 'no-store');
  const retryAfter = response.status === 429 ? response.headers.get('x-retry-after') : null;
  if (retryAfter && /^\d+$/.test(retryAfter)) response.headers.set('retry-after', retryAfter);
  return response;
}
/** A gym-bound session with the portal household it has chosen, if any. Never request input. */
export interface BoundSession extends Session {
  readonly sessionId: string;
  readonly householdId: string | null;
  /**
   * What a gym may call the login when its own records have no name: the login's own name, or its address when the name
   * is blank or the install is `multi` (there `auth_user.name` is install-wide, whatever the first gym to provision the
   * address typed, so it may be another gym's). A gym may know the person by another name still.
   */
  readonly userName: string;
}
/** Internal header naming one HTTP call's account attempt for the account-limit plugin; stripped from callers' requests. */
const accountAttemptHeader = 'x-plaingym-account-attempt';
/** One password or login-link call's account, and the reservation the plugin made for it. */
interface AccountAttempt { readonly email: string; readonly path: string; reservation: AccountReservation | null }
/** Better Auth's cookie names start with this: `__Host-better-auth` over HTTPS (production), `better-auth` otherwise. */
export function cookiePrefix(config: Pick<AuthConfig, 'production'>): string {
  return config.production ? '__Host-better-auth' : 'better-auth';
}
export const authEndpoints = [
  'POST /sign-in/email', 'POST /sign-in/magic-link', 'GET /magic-link/verify', 'GET /get-session', 'POST /sign-out',
] as const;

export function createAuthService(options: AuthServiceOptions) {
  const { config } = options;
  if (config.smtpConfigured && !options.sendMagicLink) throw new Error('Configured SMTP requires a magic-link sender');
  const database = options.database ?? systemDatabase, now = options.now ?? Date.now;
  const addressRule = options.rateLimit ?? signInLimits.address, accountRule = options.accountRateLimit ?? signInLimits.account;
  const ceilingRule = options.loginLinkCeiling ?? loginLinkCeiling;
  const pause = options.pause ?? ((milliseconds: number) => setTimeout(milliseconds).then(() => undefined));
  const elapsed = options.elapsed ?? (() => performance.now());
  /** Per gym, its newest real login-link sends' durations and when the latest one failed with the sending service
   * (epoch milliseconds, or null after a success): durations and times only, never an address or an error's text. */
  const recentSends = new Map<string, { durations: number[]; failedAt: number | null }>();
  const recordSend = (gymId: string, duration: number, failedAt: number | null) => {
    const record = recentSends.get(gymId) ?? { durations: [], failedAt: null };
    record.durations = [...record.durations, duration].slice(-5);
    record.failedAt = failedAt;
    recentSends.set(gymId, record);
  };
  /** A refusal with the standard `Retry-After` beside Better Auth's own `X-Retry-After`. */
  const tooManyRequests = (seconds: number) => Response.json({ message: 'Too many requests. Please try again later.' }, { status: 429,
    headers: { 'retry-after': String(seconds), 'x-retry-after': String(seconds), 'cache-control': 'no-store' } });
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
      const addressStorage = config.tenancy === 'multi' ? gymAddressStorage(database, gym.gymId) : undefined;
      // Each HTTP password or login-link call through this binding, under the random ID `handler` sends in the internal
      // attempt header. Its own entry holds its own reservation, so concurrent calls never release each other's.
      const attempts = new Map<string, AccountAttempt>();
      /** Whether an identity with this address has a staff role or a household login in this gym. */
      async function linked(email: string): Promise<boolean> {
        const address = email.toLowerCase();
        return scopedDatabase(database()).forGym(gym.gymId, async (tx) => {
          const [staff] = await tx.select({ userId: staffRoles.userId }).from(staffRoles)
            .innerJoin(authUser, eq(authUser.id, staffRoles.userId)).where(eq(authUser.email, address)).limit(1);
          if (staff) return true;
          const [member] = await tx.select({ userId: householdUsers.userId }).from(householdUsers)
            .innerJoin(authUser, eq(authUser.id, householdUsers.userId)).where(eq(authUser.email, address)).limit(1);
          return Boolean(member);
        });
      }
      // Better Auth runs onRequest plugins after its atomic address check, so a reservation is made only for a call the
      // address limit admitted. A request without a known attempt ID (provisioning, sessions, Google) reserves nothing.
      const accountLimit: BetterAuthPlugin = {
        id: 'account-sign-in-limit',
        async onRequest(request) {
          const id = request.headers.get(accountAttemptHeader);
          const attempt = id === null ? undefined : attempts.get(id);
          if (!attempt) return;
          const result = await reserveAccountAttempt(database(), attempt.path, attempt.email, accountRule, now(), config.tenancy === 'multi' ? gym.gymId : undefined);
          attempt.reservation = result.reservation;
          if (result.retryAfter !== null) return { response: tooManyRequests(result.retryAfter) };
        },
      };
      // One instance serves every call but Google's, which builds its own with the gym's current provider.
      const build = (google: { clientId: string; clientSecret: string } | null) => betterAuth({
        secret: config.secret, baseURL: origin.origin, basePath: '/api/auth', trustedOrigins: [origin.origin],
        database: drizzleAdapter(database(), { provider: 'pg', schema: {
          user: authUser, session: authSession, account: authAccount, verification: authVerification, rateLimit: authRateLimit,
        }, transaction: true }),
        // Its cleanup deletes every expired row on each lookup, portal invitations included, before their sweep can remove the
        // identities they provisioned. Expired tokens are still refused; `createPortalInvitationStore().sweepExpired` deletes them.
        verification: { disableCleanup: true },
        emailAndPassword: { enabled: passwordEnabled, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128, password: passwordAdapter },
        session: { additionalFields: { gymId: { type: 'string', required: true, input: false }, householdId: { type: 'string', required: false, input: false } }, cookieCache: { enabled: false } },
        // A Google login joins an existing identity only when both addresses are verified: no provider is trusted to skip
        // the check on its side, and an unverified local address (a password login set up without email) never links.
        // State stays in the database, where the Google extension checks the gym it was issued for.
        account: { accountLinking: { enabled: true, trustedProviders: [], requireLocalEmailVerified: true }, storeStateStrategy: 'database',
          encryptOAuthTokens: false, updateAccountOnSignIn: false },
        // Public signup is disabled: Google signs in identities the gym provisioned, and never with a bare ID token.
        ...(google ? { socialProviders: { google: { clientId: google.clientId, clientSecret: google.clientSecret,
          disableSignUp: true, disableIdTokenSignIn: true, prompt: 'select_account' as const } } } : {}),
        advanced: {
          // PostgreSQL/Drizzle supplies UUIDv7 record defaults. Declaring UUID
          // storage also keeps Better Auth's deterministic reservation IDs valid.
          database: { generateId: 'uuid' },
          // Over HTTPS every cookie is `__Host-better-auth.<name>`: host-only, `Secure` and `Path=/`, so no other host under
          // the same parent domain can set one. `useSecureCookies` stays off so Better Auth doesn't add `__Secure-` too.
          useSecureCookies: false, cookiePrefix: cookiePrefix(config),
          crossSubDomainCookies: { enabled: false },
          defaultCookieAttributes: { httpOnly: true, secure: config.production, sameSite: 'lax', path: '/' },
          ipAddress: { ipAddressHeaders: ['x-plaingym-client-ip'] },
        },
        databaseHooks: {
          user: { create: { before: async (user) => ({ data: { ...user, email: user.email.toLowerCase() } }) }, update: { before: async (user) => ({ data: { ...user, ...(user.email ? { email: user.email.toLowerCase() } : {}) } }) } },
          session: { create: { before: async (session) => ({ data: { ...session, gymId: gym.gymId } }) } },
          account: { create: { before: async (account) => ({ data: withoutOAuthTokens(account, true) }) },
            update: { before: async (account) => ({ data: withoutOAuthTokens(account, false) }) } },
        },
        rateLimit: { enabled: true, storage: 'database', window: 60, max: 100,
          ...(addressStorage ? { customStorage: addressStorage } : {}),
          customRules: { '/sign-in/email': addressRule, '/sign-in/magic-link': addressRule, '/magic-link/verify': addressRule, '/sign-in/social': addressRule } },
        plugins: [magicLink({
          expiresIn: options.magicLinkTtl ?? 300, storeToken: { type: 'custom-hasher', hash: async (token: string) => linkTokenHash(token) }, disableSignUp: true,
          generateToken: () => `${gym.gymId}.${randomBytes(32).toString('base64url')}`,
          sendMagicLink: async ({ email, url }, ctx) => {
            assertNoTransaction('auth.sendMagicLink');
            if (!options.sendMagicLink) throw new Error('Magic-link delivery is not configured');
            // Only the public sign-in request counts toward the gym's ceiling, and only for an address the gym hasn't linked;
            // the links the app sends itself (`sendLoginLink`) carry no attempt ID. Over the ceiling nothing is sent, and
            // the request imitates the gym's recent real sends: it waits about their median time and answers 503 while the
            // latest one failed with the sending service, so its answer matches a linked address's.
            const attemptId = (ctx?.request?.headers ?? ctx?.headers)?.get(accountAttemptHeader);
            const publicRequest = attemptId != null && attempts.get(attemptId)?.path === '/sign-in/magic-link';
            if (publicRequest && !await linked(email)) {
              const result = await reserveLoginLinkCeiling(database(), gym.gymId, ceilingRule, now());
              if (result.retryAfter !== null) {
                const at = now();
                if (at >= (ceilingLogged.get(gym.gymId) ?? 0)) {
                  ceilingLogged.set(gym.gymId, at + result.retryAfter * 1000);
                  logWarn('auth.login_link_ceiling', { gymId: gym.gymId, limit: ceilingRule.max });
                }
                const record = recentSends.get(gym.gymId);
                if (!record) return;
                const sorted = [...record.durations].sort((a, b) => a - b);
                const wait = Math.min(loginLinkAnswerWaitMs, sorted[Math.floor(sorted.length / 2)] ?? 0);
                const failing = record.failedAt !== null && now() - record.failedAt < loginLinkFailureMemoryMs;
                await pause(wait);
                if (failing) throw new APIError('SERVICE_UNAVAILABLE', { code: emailUnavailableCode, message: 'Email unavailable' });
                return;
              }
            }
            const started = elapsed();
            try {
              await options.sendMagicLink({ email: email.toLowerCase(), url, gymId: gym.gymId });
              recordSend(gym.gymId, elapsed() - started, null);
            } catch (error) {
              // The gym's sending service failed, whoever asked: Better Auth sends for every address, so this answer says
              // nothing about whether the address has an account, and a send the ceiling dropped above imitates it while
              // it is the gym's latest. The original error stays the (unsent) cause.
              const failure = emailServiceFailure(error);
              if (failure === null) throw error;
              recordSend(gym.gymId, elapsed() - started, now());
              // Better Auth logs an APIError by its message alone; name the class (never the reply or the address) here.
              logWarn('auth.magic_link_email_unavailable', { gymId: gym.gymId, failure });
              throw new APIError('SERVICE_UNAVAILABLE', { code: emailUnavailableCode, message: 'Email unavailable', cause: error });
            }
          },
        }), accountLimit, ...(google ? options.google?.plugins?.(gym) ?? [] : [])],
      });
      const auth = build(null);
      function headers(request: Request) {
        const result = new Headers(request.headers);
        // Callers never supply the client address or an attempt ID: both are set here or by `handler`.
        for (const key of [...result.keys()]) if (/^(?:forwarded$|x-forwarded-|x-real-ip$|cf-connecting-ip$|x-plaingym-client-ip$|x-plaingym-account-attempt$|host$)/i.test(key)) result.delete(key);
        result.set('x-plaingym-client-ip', gym.clientIp);
        return result;
      }
      async function readSession(request: Request) {
        assertNoTransaction('auth.getSession');
        return auth.api.getSession({ headers: headers(request), query: { disableCookieCache: true, disableRefresh: true } });
      }
      /**
       * The login a link's token would sign in as, while its row is unexpired: the login with the row's address, if any.
       * It only reads, so the token stays usable once, by whichever request completes it first.
       */
      async function linkLogin(token: string): Promise<{ id: string; email: string } | null> {
        const [row] = await database().select({ value: authVerification.value, expiresAt: authVerification.expiresAt }).from(authVerification)
          .where(eq(authVerification.identifier, 'magic-link:' + linkTokenHash(token))).limit(1);
        // Better Auth compares expiry with the system clock too.
        if (!row || row.expiresAt.getTime() <= Date.now()) return null;
        let email: unknown;
        try { email = (JSON.parse(row.value) as { email?: unknown } | null)?.email; } catch { return null; }
        if (typeof email !== 'string') return null;
        const [user] = await database().select({ id: authUser.id, email: authUser.email }).from(authUser).where(eq(authUser.email, email.toLowerCase())).limit(1);
        return user ?? null;
      }
      /** The verify call Better Auth runs for a login link: its token, and callbacks rebuilt from the resolved gym. */
      function verifyUrl(token: string, claim: string | null): URL {
        const result = new URL('/api/auth/magic-link/verify', origin);
        result.searchParams.set('token', token);
        for (const name of ['callbackURL', 'newUserCallbackURL', 'errorCallbackURL']) result.searchParams.set(name, name === 'errorCallbackURL' ? new URL('/login', origin).href : claim ?? new URL('/admin', origin).href);
        return result;
      }
      /** Completes a login link from the confirmation page's form, as the token's own login; never one the form names. */
      async function switchLogin(request: Request): Promise<Response> {
        if (!magicLinkEnabled) return new Response(null, { status: 404 });
        const session = await readSession(request);
        if (session && session.session.gymId !== gym.gymId) return Response.json({ error: 'session_gym_mismatch' }, { status: 403 });
        if (request.headers.get('origin') !== origin.origin || request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ error: 'invalid_origin' }, { status: 403 });
        let form: FormData;
        try { form = await request.formData(); } catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
        const token = form.get('token'), callback = form.get('callbackURL');
        if (typeof token !== 'string') return Response.json({ error: 'invalid_request' }, { status: 400 });
        if (!token.startsWith(`${gym.gymId}.`)) return Response.json({ error: 'invalid_token_gym' }, { status: 403 });
        const forwarded = headers(request);
        forwarded.delete('content-type'); forwarded.delete('content-length');
        return forwardedAnswer(await auth.handler(new Request(verifyUrl(token, portalClaimCallback(typeof callback === 'string' ? callback : null, origin)), { method: 'GET', headers: forwarded })));
      }
      const adapter: Auth = {
        async getSession(request): Promise<Session | null> {
          const session = await readSession(request);
          return session?.session.gymId === gym.gymId ? { userId: session.user.id } : null;
        },
      };
      return {
        ...adapter,
        /** Internal provisioning entry point; delivery always follows the owner commit.
         * A portal claim code makes the link return to the claim page, which completes the claim for the signed-in user. */
        async sendLoginLink(email: string, claimCode?: string): Promise<void> {
          assertNoTransaction('auth.sendLoginLink');
          if (!options.sendMagicLink) throw new Error('Magic-link delivery is not configured');
          if (claimCode !== undefined && !validClaimCode(claimCode)) throw new Error('Invalid portal claim code');
          const callbackURL = claimCode === undefined ? new URL('/login', origin).href : new URL(portalClaimCallbackPath + '?claim=' + claimCode, origin).href;
          try {
            await auth.api.signInMagicLink({
              headers: { origin: origin.origin, 'x-plaingym-client-ip': gym.clientIp },
              body: { email: email.trim().toLowerCase(), callbackURL },
            });
          } catch (error) {
            // Callers here handle the delivery error itself, as before the sign-in page's answer existed.
            throw error instanceof APIError && error.body?.code === emailUnavailableCode && error.cause !== undefined ? error.cause : error;
          }
        },
        async checkedSession(request: Request): Promise<BoundSession | null> {
          const session = await readSession(request);
          if (session && session.session.gymId !== gym.gymId) throw new Error('session_gym_mismatch');
          if (!session) return null;
          const householdId = (session.session as { householdId?: unknown }).householdId;
          return { userId: session.user.id, sessionId: session.session.id, householdId: typeof householdId === 'string' ? householdId : null,
            userName: (config.tenancy === 'multi' ? '' : session.user.name.trim()) || session.user.email };
        },
        async handler(request: Request): Promise<Response> {
          assertNoTransaction('auth.handler');
          const url = new URL(request.url);
          // A TLS proxy may forward over HTTP, so match the host only; the resolved gym supplies the origin below.
          if (url.host !== origin.host || !url.pathname.startsWith('/api/auth/')) return new Response(null, { status: 404 });
          const path = url.pathname.slice('/api/auth'.length);
          const key = `${request.method} ${path}`;
          // Not an allowlisted endpoint: it completes a login link through `/magic-link/verify`, and its limits, below.
          if (key === `POST ${loginSwitchPath}`) return switchLogin(request);
          const googleEndpoint = Boolean(options.google && (key === 'POST /sign-in/social' || key === 'GET /callback/google'));
          if (!authEndpoints.some((endpoint) => endpoint === key) && !googleEndpoint) return new Response(null, { status: 404 });
          // The gym's Google client as it is now: none means the Google endpoints don't exist for this gym.
          const google = googleEndpoint ? await options.google!.credentials(gym.gymId) : null;
          if (googleEndpoint && !google) return new Response(null, { status: 404 });
          if (path === '/sign-in/email' && !passwordEnabled) return new Response(null, { status: 404 });
          if ((path === '/sign-in/magic-link' || path === '/magic-link/verify') && !magicLinkEnabled) return new Response(null, { status: 404 });
          const session = await readSession(request);
          if (session && session.session.gymId !== gym.gymId) return Response.json({ error: 'session_gym_mismatch' }, { status: 403 });
          if (request.method === 'POST') {
            if (request.headers.get('origin') !== origin.origin || request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ error: 'invalid_origin' }, { status: 403 });
          }
          if (googleEndpoint && !await options.google!.beforeRequest(request, gym)) return new Response(null, { status: 403 });
          // Reconstruct callbacks and origin from the resolved gym. Never propagate caller-supplied redirects.
          let safeUrl = new URL('/api/auth' + path, origin);
          if (path === '/magic-link/verify') {
            const token = url.searchParams.get('token');
            if (!token?.startsWith(`${gym.gymId}.`)) return Response.json({ error: 'invalid_token_gym' }, { status: 403 });
            // A portal claim callback is the only other allowed destination, rebuilt from its validated code.
            const claim = portalClaimCallback(url.searchParams.get('callbackURL'), origin);
            // A browser signed in as another login keeps its session until it confirms; the page leaves the token unused.
            if (session) {
              const next = await linkLogin(token);
              if (next && next.id !== session.user.id) return loginSwitchResponse({ current: session.user.email, next: next.email, token, callbackURL: claim });
            }
            safeUrl = verifyUrl(token, claim);
          }
          let body: string | undefined;
          let accountEmail: string | undefined;
          if (request.method === 'POST') {
            let input: unknown;
            try { input = await request.json(); } catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
            if (typeof input !== 'object' || input === null) return new Response(null, { status: 400 });
            const fields = input as Record<string, unknown>;
            if (accountLimitedPaths.includes(path) && typeof fields.email === 'string') accountEmail = fields.email;
            body = JSON.stringify({ ...fields, ...(typeof fields.email === 'string' ? { email: fields.email.toLowerCase() } : {}),
              callbackURL: new URL('/admin', origin).href, newUserCallbackURL: new URL('/admin', origin).href, errorCallbackURL: new URL('/login', origin).href });
          }
          if (googleEndpoint) {
            // The extension owns provider state and callback parameters after validating the gym binding.
            safeUrl.search = url.search;
          }
          // This call's own entry for the account-limit plugin, found by a fresh ID only this call knows.
          const forwarded = headers(request);
          const attempt: AccountAttempt | undefined = accountEmail === undefined ? undefined : { email: accountEmail, path, reservation: null };
          const attemptId = attempt ? randomUUID() : undefined;
          if (attempt && attemptId) { attempts.set(attemptId, attempt); forwarded.set(accountAttemptHeader, attemptId); }
          let response: Response;
          try {
            response = await (google ? build(google) : auth).handler(new Request(safeUrl, { method: request.method, headers: forwarded, ...(body ? { body } : {}) }));
          } finally { if (attemptId) attempts.delete(attemptId); }
          // Best effort: the session already exists, so a failed release only leaves this success counted like a failure.
          if (path === '/sign-in/email' && response.status === 200 && attempt?.reservation) await releaseAccountAttempt(database(), attempt.reservation).catch(() => undefined);
          forwardedAnswer(response);
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
