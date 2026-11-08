// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { FakeUploads } from '../../infra/storage/index.js';
import { TestClock } from '../../core/clock.js';
import type { RequestEnvironment } from '../../core/context.js';
import { errorHandler } from '../../core/errors.js';
import { digest } from './snapshot.js';
import { createWaiverDocumentDelivery, createWaiverDocumentDownloadRoute, readWaiverDocument } from './document-delivery.js';

async function fixture() {
  const gymId = uuidv7(), otherGymId = uuidv7(), clock = new TestClock('2026-11-05T12:00:00Z');
  const uploads = new FakeUploads(gymId, clock), other = new FakeUploads(otherGymId, clock);
  const bytes = Buffer.from('%PDF-1.7\nSynthetic delivery test, already validated at upload.\n%%EOF');
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
    for (let i = 0; i < 10; i++) expect((await app.request('/api/waivers/template-document?token=junk')).status).toBe(404);
    const limited = await app.request(f.url.href);
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
    expect((await app.request(f.url.href, { headers: { 'test-client': '192.0.2.2' } })).status).toBe(200);
  });
  it('uses an application URL with a five-minute expiry and survives service recreation', async () => {
    const f = await fixture();
    expect(f.url.origin).toBe('https://gym.example.test');
    expect(f.issued.data.expiresAt).toBe('2026-11-05T12:05:00.000Z');
    expect(digest(await createWaiverDocumentDelivery(f.options).read(f.gymId, f.token))).toBe(f.document.hash);
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
    expect(digest(await reader.read(f.gymId, f.token))).toBe(f.document.hash);
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
    await expect(f.delivery.read(f.gymId, f.token)).rejects.toThrow('Waiver document integrity failure');
  });
  it('cancels an oversized object stream before serving any bytes', async () => {
    const f = await fixture(); let cancelled = false;
    f.uploads.get = async () => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(f.bytes.length + 1)); },
      cancel() { cancelled = true; } });
    await expect(f.delivery.read(f.gymId, f.token)).rejects.toThrow('Waiver document integrity failure');
    expect(cancelled).toBe(true);
  });
});
