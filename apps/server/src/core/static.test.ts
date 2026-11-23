// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from './app.js';

let directory: string;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plaingym-static-'));
  const publicDirectory = join(directory, 'public');
  await mkdir(join(publicDirectory, 'assets'), { recursive: true });
  await mkdir(join(publicDirectory, 'fonts'), { recursive: true });
  await mkdir(join(directory, 'private'));
  await writeFile(join(publicDirectory, 'index.html'), '<html><body>SPA</body></html>');
  await writeFile(join(publicDirectory, 'assets', 'app-12345678.js'), 'console.log("asset");');
  await writeFile(join(publicDirectory, 'assets', 'app-12345678.css'), 'body { color: red; }');
  await writeFile(join(publicDirectory, 'app.js'), 'console.log("root");');
  await writeFile(join(publicDirectory, 'icon-192.png'), 'png-bytes');
  await writeFile(join(publicDirectory, 'fonts', 'x.woff2'), 'font-bytes');
  await writeFile(join(publicDirectory, 'manifest.webmanifest'), '{}');
  await writeFile(join(publicDirectory, '.env'), 'SECRET=hidden');
  await writeFile(join(directory, 'private', 'key.txt'), 'private key');
  await symlink(join(directory, 'private'), join(publicDirectory, 'escape'), 'junction');
  app = createApp({ publicDirectory,
    resolveGym: async (context, next) => {
      context.set('context', { ...context.get('context'), gym: { gymId: 'gym', timezone: 'UTC', enabledModules: new Set() } });
      await next();
    },
    session: async (_context, next) => { await next(); },
    authorize: () => async (_context, next) => { await next(); },
  });
  app.get('/website/theme.css', (context) => context.body('theme css', 200, { 'Content-Type': 'text/css; charset=utf-8' }));
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

it('serves assets with MIME, cache, content-length, and nosniff headers', async () => {
  const response = await app.request('/assets/app-12345678.js');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  const body = await response.text();
  expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
  expect(body).toBe('console.log("asset");');
  expect((await app.request('/assets/app-12345678.css')).headers.get('content-type')).toContain('text/css');
  expect((await app.request('/manifest.webmanifest')).headers.get('content-type')).toBe('application/manifest+json');
  const script = await app.request('/app.js');
  expect(script.status).toBe(200);
  expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  expect(await script.text()).toBe('console.log("root");');
  const icon = await app.request('/icon-192.png');
  expect(icon.status).toBe(200);
  expect(icon.headers.get('content-type')).toBe('image/png');
  expect(await icon.text()).toBe('png-bytes');
});

it.each(['/admin', '/admin/members/123', '/portal', '/portal/household', '/kiosk', '/login', '/setup', '/setup/restore'])('serves the SPA entry for browser navigation to %s', async (path) => {
  const response = await app.request(path, { headers: { accept: 'text/html,application/xhtml+xml' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(response.headers.get('cache-control')).toBe('no-cache');
  expect(await response.text()).toContain('SPA');
});

it.each(['/api/missing', '/webhooks/stripe', '/l/token', '/join', '/trial', '/drop-in', '/', '/unrecognized',
  '/assets/missing.js', '/admin/missing.js', '/.env', '/%2eenv', '/assets/%2e%2e%2f.env', '/escape/key.txt',
  '/assets/%5c..%5c.env', '/assets/%00', '/assets/%ZZ',
  '/assets/app-12345678.js?n=1', '/assets/app-12345678.js?', '/assets/app-12345678.css?v=2',
  '/icon-192.png?1', '/icon-192.png?', '/app.js?v=2', '/fonts/x.woff2?x'])('never exposes files or falls back to HTML for %s', async (path) => {
  const response = await app.request(path, { headers: { accept: 'text/html' } });
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
});

it('does not replace JSON or write requests with the SPA', async () => {
  expect((await app.request('/admin', { headers: { accept: 'application/json' } })).status).toBe(404);
  expect((await app.request('/admin', { method: 'POST', headers: { accept: 'text/html' } })).status).toBe(404);
});

it.each(['/assets/app-12345678.js?n=1', '/icon-192.png?1'])('refuses a HEAD file request that carries a query string for %s', async (path) => {
  const response = await app.request(path, { method: 'HEAD' });
  expect(response.status).toBe(404);
});

it.each(['/admin?tab=billing', '/portal?x=1'])('still serves the SPA entry for a navigation that carries a query string for %s', async (path) => {
  const response = await app.request(path, { headers: { accept: 'text/html' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-cache');
  expect(await response.text()).toContain('SPA');
});

it('lets a route mounted after the middleware answer a file URL that carries a query string', async () => {
  const response = await app.request('/website/theme.css?v=1');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/css');
  expect(await response.text()).toBe('theme css');
});

it('counts asset requests that carry a query string toward the flood limit', async () => {
  const limited = createApp({ publicDirectory: join(directory, 'public'),
    rateLimit: { limit: 2, peerAddress: () => '127.0.0.1' },
    resolveGym: async (context, next) => {
      context.set('context', { ...context.get('context'), gym: { gymId: 'gym', timezone: 'UTC', enabledModules: new Set() } });
      await next();
    },
    session: async (_context, next) => { await next(); },
    authorize: () => async (_context, next) => { await next(); },
  });
  expect((await limited.request('/assets/app-12345678.js?n=1')).status).toBe(404);
  expect((await limited.request('/assets/app-12345678.js?n=2')).status).toBe(404);
  expect((await limited.request('/assets/app-12345678.js?n=3')).status).toBe(429);
  expect((await limited.request('/assets/app-12345678.js')).status).toBe(200);
});

it('handles HEAD without a response body while preserving file headers', async () => {
  const response = await app.request('/assets/app-12345678.js', { method: 'HEAD' });
  expect(response.status).toBe(200);
  expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0);
  expect(await response.text()).toBe('');
});

it('returns 404 when the deployment has no SPA files', async () => {
  const missing = createApp({ publicDirectory: join(directory, 'missing'),
    resolveGym: async (context, next) => {
      context.set('context', { ...context.get('context'), gym: { gymId: 'gym', timezone: 'UTC', enabledModules: new Set() } });
      await next();
    }, session: async (_context, next) => { await next(); }, authorize: () => async (_context, next) => { await next(); },
  });
  expect((await missing.request('/admin', { headers: { accept: 'text/html' } })).status).toBe(404);
});
