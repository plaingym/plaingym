// SPDX-License-Identifier: AGPL-3.0-only
import type { OpenAPIHono } from '@hono/zod-openapi';
import { AppError } from '@plaingym/shared';
import type { Context, MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from './context.js';
import { cspReportBytes } from './body-limit.js';
import { cspReportPath } from './csp.js';
import { logInfo } from './log.js';
import { rateLimit, type RateLimitOptions } from './rate-limit.js';
import { route, type PermissionMiddleware } from './registry.js';

/** Report requests a minute: each client, each gym (or the install, for requests that resolve no gym), and in all. */
const clientBudget = 30, gymBudget = 300, installCeiling = 3_000, windowMs = 60_000;
/** Reports logged from one request (the budgets count requests); the rest of a batch is dropped. */
const maxReportsPerRequest = 5;
const maxPathSegments = 8;
/** The fixed words of the app's own routes (SPA and public pages). Any other path segment is a name, ID or token. */
const routeWords = new Set(['admin', 'portal', 'kiosk', 'setup', 'login', 'demo', 'join', 'trial', 'drop-in', 'staff-invitation',
  'billing', 'invoices', 'plans', 'campaigns', 'checkin', 'claim', 'health', 'household', 'imports', 'members', 'outbox', 'progress',
  'ranks', 'schedule', 'settings', 'staff', 'waivers', 'received', 'checkout', 'return', 'cancelled', 'sign-in', 'portal-login',
  'signatures', 'public', 'pages']);

const directives = new Set(['default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem',
  'style-src-attr', 'img-src', 'font-src', 'connect-src', 'media-src', 'object-src', 'frame-src', 'child-src', 'worker-src',
  'manifest-src', 'prefetch-src', 'base-uri', 'form-action', 'frame-ancestors', 'navigate-to', 'sandbox', 'trusted-types',
  'require-trusted-types-for']);
const keywords = new Set(['inline', 'eval', 'wasm-eval', 'self', 'data', 'blob', 'about', 'filesystem', 'trusted-types-policy', 'trusted-types-sink']);
const webSchemes = new Set(['http:', 'https:', 'ws:', 'wss:']);

/** The violated directive's name, or `other`; anything a page can make up stays out of the log. */
export function reportedDirective(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const name = candidate.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
    if (name) return directives.has(name) ? name : 'other';
  }
  return 'unknown';
}

/** A blocked resource as its origin (web URLs), its scheme (`data:`, `blob:`) or one of the CSP keywords. Never a path or query. */
export function reportedResource(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  const text = value.trim().slice(0, 2048);
  if (keywords.has(text)) return text;
  let url: URL;
  try { url = new URL(text); } catch { return 'other'; }
  if (webSchemes.has(url.protocol)) return url.origin.length <= 255 ? url.origin : 'other';
  return /^[a-z][a-z0-9+.-]{0,31}:$/.test(url.protocol) ? url.protocol : 'other';
}

/**
 * The document's path with everything that identifies a person or a resource replaced: a signed link's token
 * (`/l/:token`) and every segment that is not one of the app's own route words (UUIDs, numbers, tokens, names).
 * No origin, query or fragment; at most eight segments.
 */
export function reportedDocumentPath(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  let url: URL;
  try { url = new URL(value.trim().slice(0, 4096)); } catch { return 'unknown'; }
  if (!['http:', 'https:'].includes(url.protocol)) return 'unknown';
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] === 'l') return segments.length > 1 ? '/l/:token' : '/l';
  const kept = segments.slice(0, maxPathSegments).map((segment) => routeWords.has(segment) ? segment : ':id');
  return '/' + kept.join('/') + (segments.length > maxPathSegments ? '/*' : '');
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

interface Violation { readonly directive: string; readonly blocked: string; readonly path: string }

/** `application/csp-report`: `{ "csp-report": { "document-uri", "blocked-uri", "effective-directive", ... } }`. */
function legacyViolations(body: unknown): Violation[] {
  const report = isRecord(body) ? body['csp-report'] : undefined;
  if (!isRecord(report)) return [];
  return [{ directive: reportedDirective(report['effective-directive'], report['violated-directive']),
    blocked: reportedResource(report['blocked-uri']), path: reportedDocumentPath(report['document-uri']) }];
}

/** `application/reports+json`: an array of `{ type, url, body: { documentURL, blockedURL, effectiveDirective, ... } }`. */
function reportingViolations(body: unknown): Violation[] {
  return (Array.isArray(body) ? body : [body]).filter((entry) => isRecord(entry) && entry.type === 'csp-violation' && isRecord(entry.body))
    .map((entry) => (entry as { body: Record<string, unknown> }).body)
    .map((report) => ({ directive: reportedDirective(report.effectiveDirective, report.violatedDirective),
      blocked: reportedResource(report.blockedURL), path: reportedDocumentPath(report.documentURL) }));
}

const formats = {
  'application/csp-report': { name: 'csp-report', read: legacyViolations },
  'application/reports+json': { name: 'reports+json', read: reportingViolations },
} as const;

export interface CspReportOptions {
  readonly limits?: RateLimitOptions | undefined;
  /** The app's tenant resolver. A report whose hostname resolves to a gym counts against that gym's budgets. */
  readonly resolveGym?: MiddlewareHandler<RequestEnvironment> | undefined;
  /** The install's restore gate, which the resolver's database read runs inside, as every tenant read does. */
  readonly restoreGate?: MiddlewareHandler<RequestEnvironment> | undefined;
}

/**
 * Sets the request's gym when its hostname resolves to one. A hostname that resolves to none (an uninitialized
 * install, an unknown host) or a closed restore gate leaves it unset; whatever answer the resolver or the gate
 * prepared is discarded.
 */
async function resolveReportGym(context: Context<RequestEnvironment>, options: CspReportOptions): Promise<void> {
  const resolveGym = options.resolveGym;
  if (!resolveGym) return;
  const resolve = () => resolveGym(context, async () => {});
  try {
    if (options.restoreGate) await options.restoreGate(context, async () => { await resolve(); });
    else await resolve();
  } catch {
    // A resolver that refuses by throwing, or a database that is briefly unavailable: the report counts as the
    // install's, and still answers 204.
  }
}

/** One fixed window for the whole process, on the request's clock. */
function windowBudget(limit: number) {
  let resetAt = 0, count = 0;
  return (now: number) => {
    if (now >= resetAt) { resetAt = now + windowMs; count = 0; }
    if (count >= limit) return false;
    count++;
    return true;
  };
}

/**
 * Each client may send 30 requests a minute, counted in memory before anything else, so a client over its budget
 * costs no database read. The request's gym is resolved next: each gym admits 300 a minute, so no gym's reports use
 * another's budget, and requests that resolve no gym share one install budget of the same size. An install ceiling
 * of 3,000 a minute counts only requests a gym's budget admitted, bounding the log however many gyms there are.
 * Every limiter answers 204 like every other outcome: a browser retries failed reports, and a flood gets nothing to
 * react to. Reports over budget are dropped unlogged.
 */
function reportBudget(options: CspReportOptions): MiddlewareHandler<RequestEnvironment> {
  // Before resolution the request has no gym, so the client limiter keys by the install and the client's address.
  const perClient = rateLimit({ ...options.limits, perGym: false, limit: clientBudget, windowMs });
  const perGym = rateLimit({ ...options.limits, perGym: true, limit: gymBudget, windowMs });
  const ceiling = windowBudget(installCeiling);
  const within = async (limiter: MiddlewareHandler<RequestEnvironment>, context: Context<RequestEnvironment>) => {
    let admitted = false;
    try { await limiter(context, async () => { admitted = true; }); }
    catch (error) { if (!(error instanceof AppError && error.code === 'rate_limited')) throw error; }
    context.header('Retry-After', undefined);
    return admitted;
  };
  return async (context, next) => {
    if (!await within(perClient, context)) return context.body(null, 204);
    await resolveReportGym(context, options);
    if (!await within(perGym, context) || !ceiling(context.get('context').clock.now().getTime())) return context.body(null, 204);
    await next();
  };
}

/**
 * The violation report endpoint for the app's Content-Security-Policy, mounted before tenancy like the other install
 * routes (it resolves the gym itself, only for its budgets). It is public and stateless: it stores nothing, never echoes
 * a body, and logs one `csp.violation` line per report holding only the directive, the blocked resource's origin or
 * keyword and the document's sanitized path.
 * Whatever the body holds, a request within the body cap and the limits answers 204.
 */
export function mountCspReports(app: OpenAPIHono<RequestEnvironment>, authorize: PermissionMiddleware, options: CspReportOptions = {}): void {
  // TODO: promote the public install contract into shared contracts.
  route({ method: 'post', path: cspReportPath, permission: { kind: 'public' }, middleware: reportBudget(options),
    responses: { 204: { description: 'Report received (or ignored)' } },
  }, async (context) => {
    const type = (context.req.header('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
    const format = Object.hasOwn(formats, type) ? formats[type as keyof typeof formats] : undefined;
    if (format) {
      // Reading is outside the try: a body over the cap fails the request as everywhere else.
      const text = await context.req.text();
      let violations: Violation[] = [];
      // The install's body limits normally refuse more; an app built with its own limits still parses no larger report.
      if (Buffer.byteLength(text) <= cspReportBytes)
        try { violations = format.read(JSON.parse(text)); } catch { /* A malformed body is dropped. */ }
      for (const violation of violations.slice(0, maxReportsPerRequest))
        logInfo('csp.violation', { format: format.name, directive: violation.directive, blocked: violation.blocked, path: violation.path });
    }
    return context.body(null, 204);
  }).mount(app, authorize);
}
