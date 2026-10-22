// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import type { MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from './context.js';

const types: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code));
}

/** Only the SPA surfaces get index fallback. API/public-page misses stay 404. */
export function staticAssets(directory = './public'): MiddlewareHandler<RequestEnvironment> {
  const root = resolve(directory);
  return async (context, next) => {
    if (!['GET', 'HEAD'].includes(context.req.method)) return next();
    let path: string;
    try { path = decodeURIComponent(context.req.path); }
    catch { return next(); }
    if (/[\\\0]/.test(path) || path.split('/').some((part) => part.startsWith('.'))
      || /^\/(?:api|webhooks|l|join|trial|drop-in)(?:\/|$)/.test(path)) return next();

    const serve = async (relative: string, immutable = false): Promise<Response | undefined> => {
      const file = resolve(root, `.${relative}`);
      if (!file.startsWith(root + sep)) return undefined;
      let bytes: Buffer;
      try {
        const [actualRoot, actualFile] = await Promise.all([realpath(root), realpath(file)]);
        if (!actualFile.startsWith(actualRoot + sep) || !(await stat(actualFile)).isFile()) return undefined;
        bytes = await readFile(actualFile);
      } catch (error) { if (missing(error)) return undefined; throw error; }
      context.header('Content-Type', types[extname(file)] ?? 'application/octet-stream');
      context.header('Content-Length', String(bytes.byteLength));
      context.header('X-Content-Type-Options', 'nosniff');
      context.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      return context.req.method === 'HEAD' ? context.body(null) : context.body(new Uint8Array(bytes));
    };
    const asset = await serve(path, path.startsWith('/assets/'));
    if (asset) return asset;
    const acceptsHtml = context.req.header('accept')?.split(',').some((type) => type.trim().split(';')[0] === 'text/html');
    if (/^\/(?:admin|portal|kiosk|login|setup)(?:\/|$)/.test(path) && !extname(path) && acceptsHtml) {
      const index = await serve('/index.html');
      if (index) return index;
    }
    return next();
  };
}
