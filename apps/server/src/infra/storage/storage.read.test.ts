// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UploadPartCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { TestClock } from '../../core/clock.js';
import { DurableUploads, type UploadBackend } from './common.js';
import { FakeUploads, FakeBackupObjectStore, LocalUploads, S3BackupObjectStore, S3Uploads, createS3Client } from './index.js';

const clock = new TestClock('2026-10-22T12:00:00Z');
describe('cancellable storage reads', () => {
  it.each(['metadata', 'object', 'cleanup'] as const)('DurableUploads cancels a pending %s read at the backend', async (stage) => {
    const controller = new AbortController(), entered = Promise.withResolvers<void>();
    const stopped = vi.fn();
    const pending = (_: string, options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      expect(options?.signal).toBe(controller.signal); entered.resolve();
      options!.signal!.addEventListener('abort', () => { stopped(); reject(options!.signal!.reason); }, { once: true });
    });
    const record = { key: 'gym/file', info: { key: 'gym/file', size: 1, contentType: 'text/plain', etag: 'test', createdAt: clock.now() } };
    const backend = { record: stage === 'object' ? async () => record : pending, get: pending } as unknown as UploadBackend;
    const uploads = new DurableUploads('gym', backend, clock);
    const result = stage === 'cleanup' ? uploads.markDeleted('gym/file', { signal: controller.signal })
      : uploads.get('gym/file', { signal: controller.signal });
    const rejection = expect(result).rejects.toThrow('stop');
    await entered.promise; controller.abort(new Error('stop')); await rejection;
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('local reads reject pre-aborted metadata and close a body when aborted after opening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plaingym-read-'));
    try {
      const uploads = new LocalUploads({ gymId: 'gym', root, signingKey: new Uint8Array(32), downloadUrl: 'https://gym.test/file', clock });
      await uploads.put('gym/file', new Uint8Array(1024 * 1024), 'application/octet-stream');
      await expect(uploads.get('gym/file', { signal: AbortSignal.abort(new Error('stop')) })).rejects.toThrow('stop');
      const metadata = new AbortController();
      const readingMetadata = uploads.get('gym/file', { signal: metadata.signal });
      metadata.abort();
      await expect(readingMetadata).rejects.toThrow();
      const controller = new AbortController();
      const body = (await uploads.get('gym/file', { signal: controller.signal }))!;
      controller.abort();
      await expect(new Response(body).arrayBuffer()).rejects.toThrow();
      // Unsignalled readers and missing objects retain their old behavior.
      expect((await new Response(await uploads.get('gym/file')).arrayBuffer()).byteLength).toBe(1024 * 1024);
      expect(await uploads.get('gym/missing')).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['headers', 'body', 'metadata', 'metadata-body', 'metadata-head', 'upload-object', 'upload-body'] as const)('S3 cancels stalled %s over HTTP and closes the socket', async (stage) => {
    const entered = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      if (stage.startsWith('upload') && request.url!.includes('/records/')) {
        response.writeHead(200); response.end(JSON.stringify({ key: 'gym/file', info: {
          key: 'gym/file', size: 7, contentType: 'text/plain', etag: 'test', createdAt: clock.now(),
        } })); return;
      }
      const stalls = stage.startsWith('upload') ? request.url!.includes('/blobs/') : stage === 'metadata-head' ? request.method === 'HEAD'
        : stage.startsWith('metadata') ? request.url!.includes('/records/') : true;
      if (!stalls) { response.writeHead(404); response.end(); return; }
      response.on('close', () => closed.resolve());
      if (stage === 'body' || stage === 'metadata-body' || stage === 'upload-body') { response.writeHead(200); response.write('partial'); }
      entered.resolve();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address() as { port: number };
    const client = createS3Client({ endpoint: `http://127.0.0.1:${address.port}`, maxAttempts: 1,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
    const controller = new AbortController();
    try {
      const read = stage.startsWith('metadata') || stage.startsWith('upload')
        ? new S3Uploads({ client, bucket: 'bucket', gymId: 'gym' }).get('gym/file', { signal: controller.signal })
        : new S3BackupObjectStore({ client, bucket: 'bucket' }).getObject('file', { signal: controller.signal });
      const consumed = read.then(body => body && new Response(body).text());
      const rejection = expect(consumed).rejects.toThrow();
      await entered.promise; controller.abort(); await rejection; await closed.promise;
    } finally { client.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('gives multipart writes time for a slow uplink and every other request the client timeout', async () => {
    const sent: [string, number | undefined][] = [];
    const client = { async send(command: object, options?: { requestTimeout?: number }) {
      sent.push([command.constructor.name, options?.requestTimeout]);
      return { UploadId: 'upload', ETag: '"etag"', ContentLength: 1, LastModified: clock.now() };
    } } as unknown as S3Client;
    const body = new Blob([new Uint8Array(6 * 1024 * 1024)]).stream();
    await new S3BackupObjectStore({ client, bucket: 'bucket' }).putObject('file', body, { partSize: 5 * 1024 * 1024 });
    expect(sent).toEqual([['CreateMultipartUploadCommand', undefined], ['UploadPartCommand', 327_680], ['UploadPartCommand', 65_536],
      ['CompleteMultipartUploadCommand', 600_000], ['HeadObjectCommand', undefined]]);
  });

  it('the default client sets a request timeout that fails the request', async () => {
    const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const client = createS3Client({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, maxAttempts: 1,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
    try {
      expect(await new S3BackupObjectStore({ client, bucket: 'bucket' }).headObject('missing')).toBeNull();
      expect((client.config.requestHandler as unknown as { httpHandlerConfigs(): object }).httpHandlerConfigs()).toMatchObject({ requestTimeout: 30_000, throwOnRequestTimeout: true });
    } finally { client.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('sends a large part without waiting for 100 Continue, so an endpoint that never answers it still gets the body', async () => {
    const server = createServer((request, response) => {
      expects.push(request.headers.expect);
      request.resume().on('end', () => { response.writeHead(200, { ETag: '"part"' }); response.end(); });
    }), expects: (string | undefined)[] = [];
    // Without this listener Node answers 100 Continue itself. With it, this endpoint never does.
    server.on('checkContinue', () => { expects.push('100-continue'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const client = createS3Client({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, maxAttempts: 1,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
    try {
      await client.send(new UploadPartCommand({ Bucket: 'bucket', Key: 'file', UploadId: 'upload', PartNumber: 1, Body: new Uint8Array(3 * 1024 * 1024) }));
      expect(expects).toEqual([undefined]);
    } finally { client.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('fakes honor cancellation while preserving reads without options', async () => {
    const uploads = new FakeUploads('gym'), backups = new FakeBackupObjectStore();
    await uploads.put('gym/file', new Uint8Array([1]), 'text/plain');
    await backups.putObject('file', new Blob(['data']).stream());
    await expect(uploads.get('gym/file', { signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(backups.getObject('file', { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(await new Response(await backups.getObject('file')).text()).toBe('data');
  });
});
