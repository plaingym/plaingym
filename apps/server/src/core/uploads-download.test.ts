// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { LocalUploads } from '../infra/storage/index.js';
import { TestClock } from './clock.js';
import type { RequestEnvironment } from './context.js';
import { errorHandler } from './errors.js';
import { uploadDownloadPath } from '../infra/storage/runtime.js';
import { createUploadDownloadRoute } from './uploads-download.js';

const clock = new TestClock('2026-10-23T12:00:00Z'), origin = 'https://gym.example.test', key = new Uint8Array(32).fill(7);
const gymA = uuidv7(), gymB = uuidv7();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
let root: string;
const uploadsFor = async (gymId: string) => new LocalUploads({ root, gymId, signingKey: key, clock,
  downloadUrl: new URL(uploadDownloadPath, origin).href });
function server(gymId: string) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => { c.set('context', { principal: { kind: 'anonymous' }, gym: { gymId, timezone: 'UTC', enabledModules: new Set() },
    requestId: 'test', clock } as RequestEnvironment['Variables']['context']); await next(); });
  app.onError(errorHandler);
  createUploadDownloadRoute({ uploadsFor, origin: () => origin }).mount(app, () => async (_c, next) => { await next(); });
  return app;
}
// The proxy forwards plain HTTP, so the app sees a different scheme than the signed link.
const fetchVia = (app: OpenAPIHono<RequestEnvironment>, url: string) => app.request(url.replace('https://', 'http://'));
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'uploads-download-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

it('streams a signed local photo inline and an export as a download', async () => {
  const uploads = await uploadsFor(gymA);
  await uploads.put(gymA + '/members/photo.png', png, 'image/png');
  await uploads.put(gymA + '/exports/run/export.zip', new Uint8Array([80, 75, 5, 6]), 'application/zip');
  const photo = await fetchVia(server(gymA), (await uploads.signedUrl(gymA + '/members/photo.png', 60))!);
  expect(photo.status).toBe(200);
  expect(Buffer.from(await photo.arrayBuffer())).toEqual(png);
  expect(Object.fromEntries(photo.headers)).toMatchObject({ 'content-type': 'image/png', 'content-disposition': 'inline',
    'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' });
  const archive = await fetchVia(server(gymA), (await uploads.signedUrl(gymA + '/exports/run/export.zip', 60))!);
  expect(archive.status).toBe(200);
  expect(archive.headers.get('content-type')).toBe('application/octet-stream');
  expect(archive.headers.get('content-disposition')).toBe('attachment; filename="export.zip"');
});
it('returns the same 404 for tampered, expired, missing, and other gyms\' links', async () => {
  const uploads = await uploadsFor(gymA);
  await uploads.put(gymA + '/members/private.png', png, 'image/png');
  const url = (await uploads.signedUrl(gymA + '/members/private.png', 60))!;
  const tampered = new URL(url); tampered.searchParams.set('key', gymA + '/members/photo.png');
  expect((await fetchVia(server(gymA), tampered.href)).status).toBe(404);
  expect((await fetchVia(server(gymB), url)).status).toBe(404);
  expect((await server(gymA).request(origin + uploadDownloadPath)).status).toBe(404);
  clock.set('2026-10-23T12:01:00Z');
  expect((await fetchVia(server(gymA), url)).status).toBe(404);
});
