// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { FakeUploads } from '../../infra/storage/index.js';
import { TestClock } from '../../core/clock.js';
import type { RequestEnvironment } from '../../core/context.js';
import { errorHandler } from '../../core/errors.js';
import { setLogSink } from '../../core/log.js';
import { digest } from './snapshot.js';
import { documentReadBudget, documentRetryPage } from './document-read.js';
import { createTranslator } from '@plaingym/shared';
import { createWaiverDocumentDelivery, createWaiverDocumentDownloadRoute, readWaiverDocument, verifyWaiverDocument } from './document-delivery.js';

const body = async (document: { body: ReadableStream<Uint8Array> }) => digest(new Uint8Array(await new Response(document.body).arrayBuffer()));
/** Captures structured log lines for one test, restoring the previous sink afterwards. */
async function withLogs<T>(run: (lines: string[]) => Promise<T>): Promise<T> {
  const lines: string[] = [], previous = setLogSink(line => lines.push(line));
  try { return await run(lines); } finally { setLogSink(previous); }
}
const integrityLog = (lines: string[], key: string) => {
  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(entry).toMatchObject({ level: 'error', event: 'waivers.document.integrity_failure', key });
  for (const secret of ['bytes', 'hash', 'url', 'signature']) expect(entry).not.toHaveProperty(secret);
};
/** A storage stream that hands out one chunk per pull and counts what it has handed out. */
function pulledStream(bytes: Uint8Array, chunk: number, counter: { pulled: number }) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunk)); offset += chunk; counter.pulled += chunk;
    },
  }, { highWaterMark: 0 });
}

async function fixture(bytes = Buffer.from('%PDF-1.7\nSynthetic delivery test, already validated at upload.\n%%EOF')) {
  const gymId = uuidv7(), otherGymId = uuidv7(), clock = new TestClock('2026-11-05T12:00:00Z');
  const uploads = new FakeUploads(gymId, clock), other = new FakeUploads(otherGymId, clock);
  const document = { key: `${gymId}/waivers/templates/${uuidv7()}.pdf`, hash: digest(bytes), bytes: bytes.length, pages: 1 };
  await uploads.put(document.key, bytes, 'application/pdf');
  const options = { key: new Uint8Array(32).fill(7), originFor: async () => 'https://gym.example.test',
    uploadsFor: async (id: string) => id === gymId ? uploads : other, clock };
  const delivery = createWaiverDocumentDelivery(options);
  const issued = await delivery.issue(gymId, document), url = new URL(issued.data.url), token = url.searchParams.get('token')!;
  function app(id = gymId) {
    const server = new OpenAPIHono<RequestEnvironment>();
    server.use('*', async (ctx, next) => { ctx.set('context', { principal: { kind: 'anonymous' },
      gym: { gymId: id, timezone: 'UTC', enabledModules: new Set() }, clock, requestId: 'document-test', clientIp: ctx.req.header('test-client') ?? '192.0.2.1' }); await next(); });
    server.onError(errorHandler);
    createWaiverDocumentDownloadRoute(() => delivery).mount(server, () => async (_ctx, next) => { await next(); });
    return server;
  }
  return { gymId, otherGymId, clock, uploads, bytes, document, options, delivery, issued, url, token, app };
}
describe('waiver document delivery', () => {
  it('limits junk tokens by client without denying other readers in the same gym', async () => {
    const f = await fixture(), app = f.app();
    for (let i = 0; i < documentReadBudget; i++) expect((await app.request('/api/waivers/template-document?token=junk')).status).toBe(404);
    const limited = await app.request(f.url.href);
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
    expect(limited.headers.get('content-type')).toContain('text/html');
    expect(await limited.text()).toContain('Wait a minute, then reload');
    expect((await app.request(f.url.href, { headers: { 'test-client': '192.0.2.2' } })).status).toBe(200);
  });
  it('serves a shared address through eight frames and repeated document opens', async () => {
    const f = await fixture(), app = f.app();
    for (let i = 0; i < 32; i++) expect((await app.request(f.url.href)).status).toBe(200);
  });
  it('turns an unavailable document into a safe page for its frame', async () => {
    const f = await fixture();
    const response = await f.app().request('/api/waivers/template-document?token=junk');
    expect(response.status).toBe(404); expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('Return to the signing page'); expect(html).toContain('href="/source"');
    expect(html).toContain('<span class="sr-only">Version </span>');
    expect(html).not.toContain('aria-label="Version');
  });
  it('passes a supplied translator to the document retry footer version label and takes its lang from a given locale', async () => {
    const server = new OpenAPIHono<RequestEnvironment>();
    const probe = createTranslator({ 'shell/shell': { version: 'Probe {version}', versionPrefix: 'Probe' } });
    server.get('/probe', ctx => documentRetryPage(ctx, 404, probe));
    server.get('/probe-fr', ctx => documentRetryPage(ctx, 404, probe, 'fr'));
    const response = await server.request('/probe');
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain('<span class="sr-only">Probe </span>');
    expect(html).toContain('<html lang="en"');
    const french = await server.request('/probe-fr');
    expect(french.status).toBe(404);
    expect(await french.text()).toContain('<html lang="fr"');
  });
  it('uses an application URL with a five-minute expiry and survives service recreation', async () => {
    const f = await fixture();
    expect(f.url.origin).toBe('https://gym.example.test');
    expect(f.issued.data.expiresAt).toBe('2026-11-05T12:05:00.000Z');
    expect(await body(await createWaiverDocumentDelivery(f.options).read(f.gymId, f.token))).toBe(f.document.hash);
  });
  it('sets PDF, sandbox, same-origin framing and no-sniff headers', async () => {
    const f = await fixture(), response = await f.app().request(f.url.href.replace('https:', 'http:'));
    expect(response.status).toBe(200);
    expect(digest(new Uint8Array(await response.arrayBuffer()))).toBe(f.document.hash);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox; frame-ancestors 'self'; report-uri /csp-report; report-to csp");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('refuses foreign gyms, altered claims, wrong signing keys and expired URLs', async () => {
    const f = await fixture();
    expect((await f.app(f.otherGymId).request(f.url.href)).status).toBe(404);
    await expect(f.delivery.read(f.otherGymId, f.token)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.delivery.read(f.gymId, 'a' + f.token.slice(1))).rejects.toMatchObject({ code: 'not_found' });
    await expect(createWaiverDocumentDelivery({ ...f.options, key: new Uint8Array(32).fill(8) }).read(f.gymId, f.token))
      .rejects.toMatchObject({ code: 'not_found' });
    f.clock.set('2026-11-05T12:05:00Z');
    await expect(f.delivery.read(f.gymId, f.token)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('reads a fresh URL issued by a process whose clock runs ahead, but not one valid past its lifetime', async () => {
    const f = await fixture(), behind = new TestClock('2026-11-05T11:59:30Z');
    const reader = createWaiverDocumentDelivery({ ...f.options, clock: behind });
    expect(await body(await reader.read(f.gymId, f.token))).toBe(f.document.hash);
    const farAhead = createWaiverDocumentDelivery({ ...f.options, clock: new TestClock('2026-11-05T12:01:01Z') });
    const long = new URL((await farAhead.issue(f.gymId, f.document)).data.url).searchParams.get('token')!;
    await expect(createWaiverDocumentDelivery(f.options).read(f.gymId, long)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('refuses deleted documents and references outside the immutable template directory', async () => {
    const f = await fixture();
    for (const key of [`${f.otherGymId}/waivers/templates/${uuidv7()}.pdf`, `${f.gymId}/waivers/templates/../file.pdf`])
      await expect(readWaiverDocument(f.uploads, f.gymId, { ...f.document, key })).rejects.toMatchObject({ code: 'not_found' });
    await f.uploads.markDeleted(f.document.key);
    await expect(f.delivery.read(f.gymId, f.token)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('verifies actual object bytes even when metadata still matches', async () => {
    const f = await fixture();
    const changed = Uint8Array.from(f.bytes); changed[10] = 0;
    f.uploads.get = async () => new ReadableStream({ start(controller) { controller.enqueue(changed); controller.close(); } });
    await expect(body(await f.delivery.read(f.gymId, f.token))).rejects.toThrow('Waiver document integrity failure');
  });
  it('cancels an oversized object stream before serving any bytes', async () => {
    const f = await fixture(); let cancelled = false;
    f.uploads.get = async () => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(f.bytes.length + 1)); },
      cancel() { cancelled = true; } });
    await expect(body(await f.delivery.read(f.gymId, f.token))).rejects.toThrow('Waiver document integrity failure');
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
  it('streams forty concurrent first reads with one storage read each, holding a few chunks each', async () => {
    const size = 2 * 1024 * 1024, chunk = 16 * 1024, large = Buffer.alloc(size, 0x20);
    large.write('%PDF-1.7\n');
    const f = await fixture(large), app = f.app(), counters: { pulled: number }[] = [];
    expect(digest(await readWaiverDocument(f.uploads, f.gymId, f.document))).toBe(f.document.hash);
    f.uploads.get = async () => { const counter = { pulled: 0 }; counters.push(counter); return pulledStream(large, chunk, counter); };
    const responses = await Promise.all(Array.from({ length: 40 }, () => app.request(f.url.href)));
    const readers = responses.map(response => {
      expect(response.status).toBe(200); expect(response.headers.get('content-length')).toBe(String(size));
      return response.body!.getReader();
    });
    for (const reader of readers) expect((await reader.read()).value).toHaveLength(chunk);
    // Each served read has taken a few chunks from storage, so the
    // forty hold at most 40 × 8 × 16 KiB = 5 MiB here, where holding each document whole would be 80 MiB.
    expect(counters).toHaveLength(40);
    for (const counter of counters) expect(counter.pulled).toBeLessThanOrEqual(8 * chunk);
    await Promise.all(readers.map(reader => reader.cancel()));
    expect(await body({ body: (await app.request(f.url.href)).body! })).toBe(f.document.hash);
    expect(counters).toHaveLength(41);
  });
  it('withholds the end of a checked document whose stored bytes changed, and checks it again on the next read', async () => {
    const f = await fixture();
    expect(await body(await f.delivery.read(f.gymId, f.token))).toBe(f.document.hash);
    const changed = Uint8Array.from(f.bytes); changed[10] = 0;
    f.uploads.get = async () => new ReadableStream({ start(controller) {
      controller.enqueue(changed.slice(0, 20)); controller.enqueue(changed.slice(20)); controller.enqueue(new Uint8Array()); controller.close();
    } });
    const reader = (await f.delivery.read(f.gymId, f.token)).body.getReader();
    let received = 0;
    await expect((async () => {
      for (;;) { const next = await reader.read(); if (next.done) return; received += next.value.length; }
    })()).rejects.toThrow('Waiver document integrity failure');
    expect(received).toBeLessThan(f.document.bytes);
    await expect(body(await f.delivery.read(f.gymId, f.token))).rejects.toThrow('Waiver document integrity failure');
  });
  it('logs once when stored bytes of the recorded size no longer match the digest', async () => {
    const f = await fixture();
    const changed = Uint8Array.from(f.bytes); changed[10] = 0;
    f.uploads.get = async () => new ReadableStream({ start(controller) {
      controller.enqueue(changed.slice(0, 20)); controller.enqueue(changed.slice(20)); controller.close();
    } });
    await withLogs(async lines => {
      await expect(body(await f.delivery.read(f.gymId, f.token))).rejects.toThrow('Waiver document integrity failure');
      integrityLog(lines, f.document.key);
    });
  });
  it('logs once when storage hands out a byte past the recorded size', async () => {
    const f = await fixture();
    const longer = new Uint8Array(f.bytes.length + 1); longer.set(f.bytes);
    f.uploads.get = async () => new ReadableStream({ start(controller) {
      controller.enqueue(longer.slice(0, 20)); controller.enqueue(longer.slice(20)); controller.close();
    } });
    await withLogs(async lines => {
      await expect(body(await f.delivery.read(f.gymId, f.token))).rejects.toThrow('Waiver document integrity failure');
      integrityLog(lines, f.document.key);
    });
  });
  it('logs once when storage ends before the recorded size', async () => {
    const f = await fixture();
    f.uploads.get = async () => new ReadableStream({ start(controller) { controller.enqueue(f.bytes.slice(0, f.bytes.length - 1)); controller.close(); } });
    await withLogs(async lines => {
      await expect(body(await f.delivery.read(f.gymId, f.token))).rejects.toThrow('Waiver document integrity failure');
      integrityLog(lines, f.document.key);
    });
  });
  it('serves an intact document without logging it', async () => {
    const f = await fixture();
    await withLogs(async lines => {
      expect(await body(await f.delivery.read(f.gymId, f.token))).toBe(f.document.hash);
      expect(lines).toEqual([]);
    });
  });
  it('leaves signing failures for its caller to log', async () => {
    const f = await fixture();
    const changed = Uint8Array.from(f.bytes); changed[10] = 0;
    f.uploads.get = async () => new ReadableStream({ start(controller) { controller.enqueue(changed); controller.close(); } });
    await withLogs(async lines => {
      await expect(verifyWaiverDocument(f.uploads, f.gymId, f.document)).rejects.toThrow('Waiver document integrity failure');
      expect(lines).toEqual([]);
    });
  });
});
