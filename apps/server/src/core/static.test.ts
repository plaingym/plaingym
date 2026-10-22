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
  await mkdir(join(directory, 'private'));
  await writeFile(join(publicDirectory, 'index.html'), '<html><body>SPA</body></html>');
  await writeFile(join(publicDirectory, 'assets', 'app-12345678.js'), 'console.log("asset");');
  await writeFile(join(publicDirectory, 'assets', 'app-12345678.css'), 'body { color: red; }');
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
  '/assets/%5c..%5c.env', '/assets/%00', '/assets/%ZZ'])('never exposes files or falls back to HTML for %s', async (path) => {
  const response = await app.request(path, { headers: { accept: 'text/html' } });
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
});

it('does not replace JSON or write requests with the SPA', async () => {
  expect((await app.request('/admin', { headers: { accept: 'application/json' } })).status).toBe(404);
  expect((await app.request('/admin', { method: 'POST', headers: { accept: 'text/html' } })).status).toBe(404);
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
