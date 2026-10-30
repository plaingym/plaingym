// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';

const nonces = new WeakMap<Context, string>();

/** A fresh nonce for this response's inline scripts. The app's default policy allows exactly the nonces issued. */
export function cspNonce(context: Context): string {
  let nonce = nonces.get(context);
  if (!nonce) { nonce = randomBytes(16).toString('base64'); nonces.set(context, nonce); }
  return nonce;
}

export interface ContentSecurityOptions {
  /** Origins that serve images directly to the browser, such as the uploads bucket's signed URLs. */
  readonly imageOrigins?: readonly string[];
}

/** Each origin must be a bare http(s) origin whose host a policy can name (letters, digits, hyphens and dots), so no
 * path or wildcard can widen the policy. */
export function imageOrigins(origins: readonly string[] = []): string[] {
  return origins.map((origin) => {
    const url = new URL(origin);
    // URL parsing accepts '*' in a host name, which a policy would read as a wildcard.
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin || !/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d+)?$/.test(url.host))
      throw new Error(`Invalid image origin: ${origin}`);
    return origin;
  });
}

/**
 * The policy for every response that sets none of its own: the SPA, its assets and the API. Scripts, styles,
 * fonts and connections stay on the app's origin, and server-rendered inline scripts need this response's nonce.
 * Images also allow data: URLs (generated QR codes). frame-ancestors is enforced separately.
 */
export function contentSecurityPolicy(options: { nonce?: string | undefined; imageOrigins?: readonly string[] } = {}): string {
  return [
    "default-src 'self'",
    "script-src 'self'" + (options.nonce ? ` 'nonce-${options.nonce}'` : ''),
    "style-src 'self'",
    ["img-src 'self' data:", ...options.imageOrigins ?? []].join(' '),
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/** The nonce issued for this response, if a page asked for one. */
export function issuedNonce(context: Context): string | undefined { return nonces.get(context); }
