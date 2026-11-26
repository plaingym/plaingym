// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { CookieOptions } from 'hono/utils/cookie';

export interface CookieSettings {
  /**
   * Name the app's own cookies `__Host-<name>`, which a browser accepts only with `Secure`, `Path=/` and no `Domain`, so
   * no page on another host under the same parent domain can set one. The runtime turns it on for production (HTTPS).
   */
  readonly hostPrefix: boolean;
  /**
   * With `hostPrefix`, also accept a cookie under its unprefixed name, as set before the prefix existed, so nobody's
   * pending checkout or join is lost by the update. Single-gym installs only, and until 1.1.0, which drops it: until then,
   * a host under the same parent domain could still set the old name, as it could before the prefix.
   */
  readonly legacyNames: boolean;
}

let settings: CookieSettings = { hostPrefix: false, legacyNames: false };

/** Set once at startup; until then cookies keep their plain names (development over HTTP and isolated tests). */
export function configureCookies(next: CookieSettings): void {
  settings = { hostPrefix: next.hostPrefix, legacyNames: next.hostPrefix && next.legacyNames };
}

/** The name the browser stores one of the app's own cookies under. */
export function appCookieName(name: string): string {
  return settings.hostPrefix ? '__Host-' + name : name;
}

/**
 * Options apart from `prefix` and `domain`, which this module decides; with the host prefix it also sets `Path=/`. Give
 * `path: '/'` anyway: `deleteAppCookie` expires only that path.
 */
export type AppCookieOptions = Omit<CookieOptions, 'prefix' | 'domain'>;

/**
 * Sets one of the app's own cookies. With the host prefix it is always `Secure`, `Path=/` and has no `Domain`, whatever
 * `options` say; without it, `options` apply as given.
 */
export function setAppCookie(c: Context, name: string, value: string, options: AppCookieOptions): void {
  if (settings.hostPrefix) setCookie(c, name, value, { ...options, prefix: 'host' });
  else setCookie(c, name, value, options);
}

/** The cookie's value under its current name, or (single-gym installs with the host prefix) its old unprefixed name. */
export function readAppCookie(c: Context, name: string): string | undefined {
  if (!settings.hostPrefix) return getCookie(c, name);
  return getCookie(c, name, 'host') ?? (settings.legacyNames ? getCookie(c, name) : undefined);
}

/** Expires a cookie set at `Path=/`; with the host prefix, under both its current and its old unprefixed name. */
export function deleteAppCookie(c: Context, name: string): void {
  const attributes = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 0 } as const;
  if (settings.hostPrefix) setCookie(c, name, '', { ...attributes, prefix: 'host' });
  setCookie(c, name, '', attributes);
}
