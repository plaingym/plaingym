// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';

type Stored = { bytes: Buffer; contentType: string; etag: string; modified: string };
type Multipart = { key: string; contentType: string; parts: Map<number, Stored> };
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const stored = (bytes: Buffer, contentType: string): Stored => ({ bytes, contentType,
  etag: '"' + createHash('md5').update(bytes).digest('hex') + '"', modified: 'Thu, 22 Oct 2026 12:00:00 GMT' });

/** Loopback S3 protocol fixture: requests travel through the real SDK and HTTP stack. */
export async function s3Server() {
  const objects = new Map<string, Stored>();
  const uploads = new Map<string, Multipart>();
  const state = { aborted: 0, failPart: 0, failComplete: false, failAbort: false,
    completedPartSizes: [] as number[][], requests: 0 };
  const xml = (response: ServerResponse, body: string, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/xml' }); response.end(body);
  };
  const failure = (response: ServerResponse, code: string, status: number) => xml(response,
    `<Error><Code>${code}</Code><Message>${code}</Message></Error>`, status);
  async function handle(request: IncomingMessage, response: ServerResponse) {
    state.requests++;
    const url = new URL(request.url!, 'http://localhost');
    const key = decodeURIComponent(url.pathname).slice(1);
    const bucket = key.split('/')[0]!;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const type = request.headers['content-type'] ?? 'application/octet-stream';
    const id = url.searchParams.get('uploadId');
    const upload = id ? uploads.get(id) : undefined;
    if (url.searchParams.has('uploads') && request.method === 'POST') {
      const uploadId = randomUUID(); uploads.set(uploadId, { key, contentType: type, parts: new Map() });
      xml(response, `<InitiateMultipartUploadResult><Bucket>storage</Bucket><Key>${escape(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`); return;
    }
    if (id) {
      if (!upload || upload.key !== key) { failure(response, 'NoSuchUpload', 404); return; }
      if (request.method === 'DELETE') {
        if (state.failAbort) { failure(response, 'AccessDenied', 403); return; }
        uploads.delete(id); state.aborted++; response.writeHead(204); response.end(); return;
      }
      if (request.method === 'PUT') {
        const part = Number(url.searchParams.get('partNumber'));
        if (state.failPart === part) { failure(response, 'InternalError', 500); return; }
        const object = stored(bytes, type); upload.parts.set(part, object);
        response.writeHead(200, { ETag: object.etag }); response.end(); return;
      }
      if (request.method === 'POST') {
        if (state.failComplete) { failure(response, 'InternalError', 500); return; }
        const parts = [...upload.parts.entries()].sort(([a], [b]) => a - b);
        const requested = [...bytes.toString().matchAll(/<PartNumber>([0-9]+)<\/PartNumber>/g)].map((match) => Number(match[1]));
        if (JSON.stringify(requested) !== JSON.stringify(parts.map(([number]) => number))) {
          failure(response, 'InvalidPartOrder', 400); return;
        }
        const sizes = parts.map(([, object]) => object.bytes.length);
        if (sizes.slice(0, -1).some((size) => size < 5 * 1024 * 1024 || size !== sizes[0])) {
          failure(response, 'EntityTooSmall', 400); return;
        }
        state.completedPartSizes.push(sizes);
        const object = stored(Buffer.concat(parts.map(([, part]) => part.bytes)), upload.contentType);
        objects.set(key, object); uploads.delete(id);
        xml(response, `<CompleteMultipartUploadResult><Bucket>storage</Bucket><Key>${escape(key)}</Key><ETag>${escape(object.etag)}</ETag></CompleteMultipartUploadResult>`); return;
      }
    }
    if (url.searchParams.has('list-type')) {
      const prefix = bucket + '/' + (url.searchParams.get('prefix') ?? '');
      const offset = Number(url.searchParams.get('continuation-token') ?? 0);
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const page = keys.slice(offset, offset + 2); const more = offset + 2 < keys.length;
      xml(response, `<ListBucketResult><Name>storage</Name><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${offset + 2}</NextContinuationToken>` : ''}${page.map((key) => {
        const object = objects.get(key)!;
        return `<Contents><Key>${escape(key.slice(bucket.length + 1))}</Key><LastModified>${new Date(object.modified).toISOString()}</LastModified><ETag>${escape(object.etag)}</ETag><Size>${object.bytes.length}</Size></Contents>`;
      }).join('')}</ListBucketResult>`); return;
    }
    if (request.method === 'PUT') {
      if (request.headers['if-none-match'] === '*' && objects.has(key)) { failure(response, 'PreconditionFailed', 412); return; }
      const object = stored(bytes, type); objects.set(key, object);
      response.writeHead(200, { ETag: object.etag }); response.end(); return;
    }
    if (request.method === 'DELETE') { objects.delete(key); response.writeHead(204); response.end(); return; }
    const object = objects.get(key);
    if (!object) { failure(response, 'NoSuchKey', 404); return; }
    response.writeHead(200, { ETag: object.etag, 'Content-Length': String(object.bytes.length),
      'Content-Type': object.contentType, 'Last-Modified': object.modified });
    response.end(request.method === 'HEAD' ? undefined : object.bytes);
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No S3 fixture address');
  return { endpoint: `http://127.0.0.1:${address.port}`, objects, uploads, state,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
