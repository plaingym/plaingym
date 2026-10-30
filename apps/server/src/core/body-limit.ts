// SPDX-License-Identifier: AGPL-3.0-only
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import { AppError } from '@plaingym/shared';
import { MAX_CSV_BYTES } from '../areas/imports/pipeline.csv.js';
import type { RequestEnvironment } from './context.js';
import { cspReportPath } from './csp.js';

export interface BodyLimits {
  /** Bytes allowed for any route without its own entry. */
  readonly default: number;
  /** Exact path or `prefix/*` → bytes. */
  readonly routes: Readonly<Record<string, number>>;
}
/** Photos are the largest JSON bodies (720 kB); a CSV upload carries its multipart framing. Join's form and admission
 * carry a family's signature images (4 MiB, checked again by join itself). The native join form gets twice that here,
 * so join's own check answers a declared oversized length with its page; a chunked body is buffered up to this limit. */
const join = 4 * 1024 * 1024;
/** Violation reports are a few hundred bytes each; the public report route takes a handful per request. */
export const cspReportBytes = 16 * 1024;
export const defaultBodyLimits: BodyLimits = {
  default: 1024 * 1024,
  routes: { '/api/auth/*': 64 * 1024, '/api/imports/uploads': MAX_CSV_BYTES + 1024 * 1024,
    '/join': 2 * join, '/join/signatures': join, [cspReportPath]: cspReportBytes },
};

/**
 * Caps every request body before anything reads it, including the auth handler and multipart parsing.
 * A declared length over the cap is refused unread; a chunked body stops being read at the cap.
 */
export function requestBodyLimit(limits: BodyLimits = defaultBodyLimits): MiddlewareHandler<RequestEnvironment> {
  const sizes = [limits.default, ...Object.values(limits.routes)];
  if (!sizes.every((size) => Number.isSafeInteger(size) && size > 0)) throw new Error('Body limits must be positive integers');
  const onError = () => { throw new AppError('invalid_request', 'Request too large'); };
  const limiter = new Map([...new Set(sizes)].map((size) => [size, bodyLimit({ maxSize: size, onError })]));
  const routes = Object.entries(limits.routes);
  return async (context, next) => {
    const path = context.req.path;
    const match = routes.find(([route]) => route.endsWith('/*')
      ? path === route.slice(0, -2) || path.startsWith(route.slice(0, -1)) : path === route);
    return limiter.get(match?.[1] ?? limits.default)!(context, next);
  };
}
