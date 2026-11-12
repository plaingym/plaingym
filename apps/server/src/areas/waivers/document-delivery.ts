// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError, type Clock } from '@plaingym/shared';
import { waiverDocumentSchema, type WaiverDocument } from '@plaingym/shared/contracts';
import type { Uploads } from '../../infra/storage/index.js';
import { route } from '../../core/registry.js';
import { setPolicy } from '../../core/csp.js';
import { documentReadLimit } from './document-read.js';
import { clock as defaultClock } from '../../core/clock.js';
import { digest } from './snapshot.js';

export const documentDownloadPath = '/api/waivers/template-document';
const lifetimeMs = 300_000;
// Another app process may have issued the URL with a clock slightly ahead of this one.
const clockSkewMs = 60_000;
const byteLimit = 10 * 1024 * 1024;
const claimSchema = z.strictObject({ gymId: z.uuid(), document: waiverDocumentSchema, expires: z.number().int().safe() });
function notFound(): never { throw new AppError('not_found', 'Document not found'); }

/** Read the immutable object through either provider, checking its complete bytes before serving it. */
export async function headWaiverDocument(uploads: Uploads, gymId: string, document: WaiverDocument): Promise<void> {
  const prefix = `${gymId}/waivers/templates/`;
  if (!document.key.startsWith(prefix) || !/^[0-9a-f-]{36}\.pdf$/.test(document.key.slice(prefix.length))) notFound();
  const info = await uploads.head(document.key);
  if (!info || info.deletedAt || info.contentType !== 'application/pdf' || info.size !== document.bytes || info.size > byteLimit) notFound();
}
export async function readWaiverDocument(uploads: Uploads, gymId: string, document: WaiverDocument): Promise<Uint8Array<ArrayBuffer>> {
  await headWaiverDocument(uploads, gymId, document);
  const stream = await uploads.get(document.key);
  if (!stream) notFound();
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > document.bytes || size > byteLimit) throw new Error('Waiver document integrity failure');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  const bytes = Buffer.concat(chunks);
  if (size !== document.bytes || digest(bytes) !== document.hash) throw new Error('Waiver document integrity failure');
  return bytes;
}

/** The runtime supplies a stable, purpose-derived key and the gym's canonical origin. */
export function createWaiverDocumentDelivery(options: {
  key: Uint8Array;
  originFor: (gymId: string) => Promise<string>;
  uploadsFor: (gymId: string) => Promise<Uploads>;
  clock?: Clock;
}) {
  if (options.key.length < 32) throw new Error('Waiver document signing key must have at least 32 bytes');
  const key = Uint8Array.from(options.key), clock = options.clock ?? defaultClock;
  const mac = (payload: string) => createHmac('sha256', key).update('waiver-document-v1\n').update(payload).digest();
  const service = {
    async issue(gymId: string, document: WaiverDocument) {
      const expires = clock.now().getTime() + lifetimeMs;
      const claim = claimSchema.parse({ gymId, document, expires });
      const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
      const origin = new URL(await options.originFor(gymId));
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.href !== origin.origin + '/')
        throw new Error('Invalid waiver document origin');
      const url = new URL(documentDownloadPath, origin);
      url.searchParams.set('token', `${payload}.${mac(payload).toString('base64url')}`);
      return { data: { url: url.href, expiresAt: new Date(expires).toISOString() } };
    },
    async read(gymId: string, token: string) {
      if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) notFound();
      const [payload, signature] = token.split('.');
      const actual = Buffer.from(signature!, 'base64url'), expected = mac(payload!);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) notFound();
      let decoded: unknown;
      try { decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')); } catch { notFound(); }
      const parsed = claimSchema.safeParse(decoded);
      if (!parsed.success) notFound();
      const claim = parsed.data, now = clock.now().getTime();
      if (claim.gymId !== gymId || claim.expires <= now || claim.expires > now + lifetimeMs + clockSkewMs) notFound();
      return readWaiverDocument(await options.uploadsFor(gymId), gymId, claim.document);
    },
  };
  return service;
}
export type WaiverDocumentDelivery = ReturnType<typeof createWaiverDocumentDelivery>;

/** Both disk and S3 documents use this response so their security headers are identical. */
export function createWaiverDocumentDownloadRoute(delivery: () => WaiverDocumentDelivery) {
  return route({ method: 'get', path: documentDownloadPath, permission: { kind: 'public' },
    middleware: documentReadLimit(true),
    request: { query: z.strictObject({ token: z.string().max(2048) }) },
    responses: { 200: { description: 'Waiver template document', content: { 'application/pdf': { schema: z.string().openapi({ format: 'binary' }) } } } },
  }, async ctx => {
    const bytes = await delivery().read(ctx.get('context').gym.gymId, ctx.req.valid('query').token);
    setPolicy(ctx, ["default-src 'none'", 'sandbox', "frame-ancestors 'self'"]);
    return ctx.body(bytes, 200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="waiver.pdf"',
      'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' });
  });
}
