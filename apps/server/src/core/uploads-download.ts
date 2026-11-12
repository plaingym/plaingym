// SPDX-License-Identifier: AGPL-3.0-only
import { installContracts } from '@plaingym/shared/contracts';
import type { Context } from 'hono';
import { AppError } from '@plaingym/shared';
import { LocalUploads, type Uploads } from '../infra/storage/index.js';
import type { RequestEnvironment } from './context.js';
import { setPolicy } from './csp.js';
import { route, type RouteRegistration } from './registry.js';

const inline = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Serves signed local-disk download links (S3 links point at the bucket instead). The signature,
 * not a session, grants access: the kiosk shows photos and export links open in a new tab.
 * Every invalid, expired, or foreign link is the same 404.
 */
export function createUploadDownloadRoute(options: {
  readonly uploadsFor: (gymId: string) => Promise<Uploads>;
  readonly origin: (context: Context<RequestEnvironment>) => string;
}): RouteRegistration {
  return route(installContracts.uploadDownload, async (c) => {
    const uploads = await options.uploadsFor(c.get('context').gym.gymId);
    // Links are signed for the gym's public origin; behind the proxy the request URL is plain HTTP.
    const requested = new URL(c.req.url), signed = new URL(requested.pathname + requested.search, options.origin(c));
    const body = uploads instanceof LocalUploads ? await uploads.getSigned(signed.href) : null;
    const info = body ? await uploads.head(signed.searchParams.get('key')!) : null;
    if (!body || !info) {
      await body?.cancel();
      throw new AppError('not_found', 'File not found');
    }
    const name = (info.key.split('/').at(-1) ?? 'download').replace(/[^A-Za-z0-9._-]/g, '_');
    // Stored content types come from uploads; only known image types render, everything else downloads.
    setPolicy(c, ["default-src 'none'", 'sandbox']);
    return c.body(body, 200, { 'Content-Type': inline.has(info.contentType) ? info.contentType : 'application/octet-stream',
      'Content-Disposition': inline.has(info.contentType) ? 'inline' : `attachment; filename="${name}"`,
      'Content-Length': String(info.size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer' });
  });
}
