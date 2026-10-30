// SPDX-License-Identifier: AGPL-3.0-only
import type { OpenAPIHono } from '@hono/zod-openapi';
import { AppError } from '@plaingym/shared';
import type { MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from './context.js';
import { cspReportPath } from './csp.js';
import { logInfo } from './log.js';
import { rateLimit, type RateLimitOptions } from './rate-limit.js';
import { route, type PermissionMiddleware } from './registry.js';

/** Each client may send this many reports a minute, and the whole install ten times as many. */
const clientBudget = 30, installBudget = 300, windowMs = 60_000;
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

/**
 * Both limiters answer 204 like every other outcome: a browser retries failed reports, and a flood gets
 * nothing to react to. Reports over budget are dropped unlogged.
 */
function reportBudget(options: RateLimitOptions | undefined): MiddlewareHandler<RequestEnvironment> {
  const perClient = rateLimit({ ...options, perGym: false, limit: clientBudget, windowMs });
  const perInstall = rateLimit({ ...options, perGym: true, limit: installBudget, windowMs });
  return async (context, next) => {
    let admitted = false;
    try {
      await perClient(context, async () => { await perInstall(context, async () => { admitted = true; }); });
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'rate_limited')) throw error;
      context.header('Retry-After', undefined);
    }
    if (!admitted) return context.body(null, 204);
    await next();
  };
}

/**
 * The violation report endpoint for the app's Content-Security-Policy, mounted before tenancy like the other install
 * routes. It is public and stateless: it stores nothing, never echoes a body, and logs one `csp.violation` line per
 * report holding only the directive, the blocked resource's origin or keyword and the document's sanitized path.
 * Whatever the body holds, a request within the body cap and the limits answers 204.
 */
export function mountCspReports(app: OpenAPIHono<RequestEnvironment>, authorize: PermissionMiddleware, limits?: RateLimitOptions): void {
  // TODO: promote the public install contract into shared contracts.
  route({ method: 'post', path: cspReportPath, permission: { kind: 'public' }, middleware: reportBudget(limits),
    responses: { 204: { description: 'Report received (or ignored)' } },
  }, async (context) => {
    const type = (context.req.header('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
    const format = Object.hasOwn(formats, type) ? formats[type as keyof typeof formats] : undefined;
    if (format) {
      // Reading is outside the try: a body over the cap fails the request as everywhere else.
      const text = await context.req.text();
      let violations: Violation[] = [];
      try { violations = format.read(JSON.parse(text)); } catch { /* A malformed body is dropped. */ }
      for (const violation of violations.slice(0, maxReportsPerRequest))
        logInfo('csp.violation', { format: format.name, directive: violation.directive, blocked: violation.blocked, path: violation.path });
    }
    return context.body(null, 204);
  }).mount(app, authorize);
}
