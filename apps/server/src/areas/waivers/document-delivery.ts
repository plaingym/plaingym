// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError, type Clock } from '@plaingym/shared';
import { waiverDocumentSchema, type WaiverDocument } from '@plaingym/shared/contracts';
import type { Uploads } from '../../infra/storage/index.js';
import { route } from '../../core/registry.js';
import { setPolicy } from '../../core/csp.js';
import { documentReadLimit } from './document-read.js';
import { clock as defaultClock } from '../../core/clock.js';

export const documentDownloadPath = '/api/waivers/template-document';
const lifetimeMs = 300_000;
// Another app process may have issued the URL with a clock slightly ahead of this one.
const clockSkewMs = 60_000;
const byteLimit = 10 * 1024 * 1024;
const claimSchema = z.strictObject({ gymId: z.uuid(), document: waiverDocumentSchema, expires: z.number().int().safe() });
function notFound(): never { throw new AppError('not_found', 'Document not found'); }

/** Check the immutable object's place and metadata through either provider before any of its bytes are read. */
export async function headWaiverDocument(uploads: Uploads, gymId: string, document: WaiverDocument): Promise<void> {
  const prefix = `${gymId}/waivers/templates/`;
  if (!document.key.startsWith(prefix) || !/^[0-9a-f-]{36}\.pdf$/.test(document.key.slice(prefix.length))) notFound();
  const info = await uploads.head(document.key);
  if (!info || info.deletedAt || info.contentType !== 'application/pdf' || info.size !== document.bytes || info.size > byteLimit) notFound();
}
const integrityFailure = () => new Error('Waiver document integrity failure');
/**
 * Passes the object's bytes through while counting and hashing them. A byte past the recorded size fails at once
 * (cancelling the source), and the last chunk is held back until the digest matches, so a reader never receives the
 * complete recorded length of altered bytes. Memory is one chunk, whatever the document's size.
 */
function checked(document: WaiverDocument, onFailure: () => void = () => {}) {
  const hash = createHash('sha256');
  let size = 0, held: Uint8Array | undefined;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.length;
      if (size > document.bytes || size > byteLimit) { onFailure(); throw integrityFailure(); }
      hash.update(chunk);
      if (held) controller.enqueue(held);
      held = chunk;
    },
    flush(controller) {
      if (size !== document.bytes || hash.digest('hex') !== document.hash) { onFailure(); throw integrityFailure(); }
      if (held) controller.enqueue(held);
    },
  });
}
async function checkedStream(uploads: Uploads, document: WaiverDocument, onFailure?: () => void) {
  const stream = await uploads.get(document.key);
  if (!stream) notFound();
  return stream.pipeThrough(checked(document, onFailure));
}
/** Reads the whole object once to check its digest, holding one chunk at a time. */
async function verifyWaiverDocument(uploads: Uploads, document: WaiverDocument) {
  const reader = (await checkedStream(uploads, document)).getReader();
  while (!(await reader.read()).done) { /* Hashing happens as the chunks pass. */ }
}
/** For the PDF queue, which needs the bytes themselves: one buffer of the recorded size, filled as the checked chunks arrive. */
export async function readWaiverDocument(uploads: Uploads, gymId: string, document: WaiverDocument): Promise<Uint8Array<ArrayBuffer>> {
  await headWaiverDocument(uploads, gymId, document);
  const reader = (await checkedStream(uploads, document)).getReader(), bytes = new Uint8Array(document.bytes);
  let offset = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes.set(next.value, offset);
    offset += next.value.length;
  }
  return bytes;
}
// Verified documents are remembered by key, digest and size (keys are immutable and gym-prefixed); a later read
// streams straight from storage and is still checked on the way out.
const verifiedLimit = 256;

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
  const verified = new Map<string, Promise<void>>();
  /**
   * A document is served as a stream, never held whole: the first read of a document checks its digest without
   * keeping its bytes (concurrent first reads share that check), then every read streams through the same check,
   * which withholds the last chunk unless the digest still matches.
   */
  async function stream(uploads: Uploads, gymId: string, document: WaiverDocument) {
    await headWaiverDocument(uploads, gymId, document);
    const id = `${document.key}\n${document.hash}\n${document.bytes}`;
    let verification = verified.get(id);
    if (!verification) {
      const pending = verifyWaiverDocument(uploads, document);
      verification = pending;
      verified.set(id, pending);
      if (verified.size > verifiedLimit) verified.delete(verified.keys().next().value!);
      pending.catch(() => { if (verified.get(id) === pending) verified.delete(id); });
    }
    await verification;
    return { body: await checkedStream(uploads, document, () => verified.delete(id)), bytes: document.bytes };
  }
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
      return stream(await options.uploadsFor(gymId), gymId, claim.document);
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
    const document = await delivery().read(ctx.get('context').gym.gymId, ctx.req.valid('query').token);
    setPolicy(ctx, ["default-src 'none'", 'sandbox', "frame-ancestors 'self'"]);
    return ctx.body(document.body, 200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="waiver.pdf"',
      'Content-Length': String(document.bytes), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' });
  });
}
