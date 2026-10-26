// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { createServer, request as forward } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { waiverContracts } from '@plaingym/shared/contracts';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createApp } from '../../app.js';
import { TestClock } from '../../core/clock.js';
import { areaContributions } from '../../core/registry-areas.js';
import { createRuntimeUploads } from '../../infra/storage/runtime.js';
import { s3Server } from '../../infra/storage/s3-server.test-helper.js';
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';
import { createMembersService } from '../members/members.js';
import { createMemberPhotoService } from '../members/photos.js';
import { authorize } from '../staff/auth.permissions.js';
import { createWaiversService } from './waivers.js';
import { configureWaivers } from './waivers.routes.js';
import { renderWaiver } from './pdf.js';

const db = useTestDatabase(), factory = createFactories(db);

/** Count the HTTP requests reaching the S3 protocol fixture, including failed writes. */
async function countedS3() {
  const s3 = await s3Server(), methods: string[] = [];
  let fail: ((method: string, url: URL) => boolean) | undefined;
  const proxy = createServer((req, res) => {
    methods.push(req.method!);
    if (fail?.(req.method!, new URL(req.url!, s3.endpoint))) {
      fail = undefined; req.resume();
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      res.end('<Error><Code>AccessDenied</Code><Message>Injected storage failure</Message></Error>'); return;
    }
    const upstream = forward(s3.endpoint + req.url, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode!, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return { methods, state: s3.state, endpoint: `http://127.0.0.1:${address.port}`,
    failOnce(matches: (method: string, url: URL) => boolean) { fail = matches; }, async close() {
    proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); await s3.close();
  } };
}
const writes = (methods: string[]) => methods.filter(method => !['GET', 'HEAD'].includes(method));

async function fixture(demo = true) {
  const s3 = await countedS3(), clock = new TestClock('2026-10-25T12:00:00Z');
  const uploads = createRuntimeUploads({ ...(demo ? { DEMO_MODE: 'true' } : {}), TENANCY: 'multi',
    UPLOADS_S3_BUCKET: 'waivers', UPLOADS_S3_ENDPOINT: s3.endpoint, UPLOADS_S3_REGION: 'us-east-1',
    UPLOADS_S3_ACCESS_KEY_ID: 'test', UPLOADS_S3_SECRET_ACCESS_KEY: 'test' }, Buffer.alloc(32, 3), async () => 'https://demo.example.test');
  const seed = createWaiversService({ scope: db.forGym, clock, uploadsFor: uploads.forSeed });
  const render = vi.fn(renderWaiver);
  const service = configureWaivers({ scope: db.forGym, clock, uploadsFor: uploads.forGym, render });
  const gyms = await Promise.all([0, 1].map(async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    const user = await factory('authUser', gymId), member = await factory('members', gymId, { dateOfBirth: '1990-01-01' });
    const ctx = { gymId, actor: { kind: 'system' as const } };
    const template = await seed.createTemplate(ctx, { name: 'Participation', kind: 'waiver', body: 'Immutable demo terms' });
    const image = await seed.uploadSignature(ctx, member.id, demoSignaturePng());
    const signature = await seed.sign(ctx, { memberId: member.id, templateId: template.id, templateVersion: 1,
      signer: { kind: 'self', name: 'Demo Member' }, ...image, consent: true }, { timezone: 'UTC', ipAddress: 'seed' });
    return { gymId, member, signature, user, ctx, origin: `https://${gymId}.demo.example.test` };
  }));
  const app = createApp({ clock, origin: 'https://demo.example.test', skipSetup: true, authorize, contributions: areaContributions,
    resolveGym: async (c, next) => {
      const gym = gyms.find(gym => new URL(c.req.url).origin === gym.origin)!;
      c.set('context', { ...c.get('context'), gym: { gymId: gym.gymId, timezone: 'UTC', enabledModules: new Set() }, clientIp: c.req.header('test-ip') ?? '192.0.2.1' });
      await next();
    },
    session: async (c, next) => {
      const gym = gyms.find(gym => gym.gymId === c.get('context').gym.gymId)!;
      c.set('context', { ...c.get('context'), principal: { kind: 'staff', gymId: gym.gymId, userId: gym.user.id, roles: ['owner'] } }); await next();
    },
  });
  return { s3, clock, uploads, service, render, gyms, app, async close() { uploads.close(); await s3.close(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const pdfRequest = (f: Fixture, gym = f.gyms[0]!, ip = '192.0.2.1') => f.app.request(`${gym.origin}/api/waivers/signatures/${gym.signature.id}/pdf`, { headers: { 'test-ip': ip } });
async function link(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return waiverContracts.pdf.response.parse(await response.json()).data;
}

it('reuses one demo PDF across concurrent downloads and service recreation, with its original hash and five-minute links', async () => {
  const f = await fixture();
  try {
    const before = f.s3.methods.length;
    const links = await Promise.all((await Promise.all([pdfRequest(f), pdfRequest(f, f.gyms[0], '192.0.2.2')])).map(link));
    expect(f.render).toHaveBeenCalledTimes(1);
    expect(writes(f.s3.methods.slice(before))).toEqual(['PUT', 'POST', 'PUT', 'POST', 'PUT']);
    const cached = f.s3.methods.length;
    for (let i = 0; i < 4; i++) await link(await pdfRequest(f));
    const recreated = createWaiversService({ scope: db.forGym, clock: f.clock, uploadsFor: f.uploads.forGym,
      render: async () => { throw new Error('Cached download must not render'); } });
    await recreated.pdf(f.gyms[0]!.gymId, f.gyms[0]!.signature.id);
    expect(writes(f.s3.methods.slice(cached))).toEqual([]);
    expect(f.render).toHaveBeenCalledTimes(1);
    for (const data of links) {
      expect(data.expiresAt).toBe('2026-10-25T12:05:00.000Z');
      expect(new URL(data.url).searchParams.get('X-Amz-Expires')).toBe('300');
      expect(new URL(data.url).pathname).toBe(new URL(links[0]!.url).pathname);
    }
    const download = await fetch(links[0]!.url); expect(download.status).toBe(200);
    const bytes = new Uint8Array(await download.arrayBuffer()), copy = f.gyms[0]!.signature;
    expect(Buffer.from(await renderWaiver(copy.snapshot, copy.snapshotHash, demoSignaturePng()))).toEqual(Buffer.from(bytes));
    const task = getDocument({ data: bytes, useSystemFonts: false });
    try {
      const content = await (await (await task.promise).getPage(1)).getTextContent();
      expect(content.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ')).toContain(f.gyms[0]!.signature.snapshotHash);
    } finally { await task.destroy(); }
    const requests = f.s3.methods.length;
    const foreign = await f.app.request(`${f.gyms[0]!.origin}/api/waivers/signatures/${f.gyms[1]!.signature.id}/pdf`);
    expect(foreign.status).toBe(404); expect(f.s3.methods).toHaveLength(requests);
  } finally { await f.close(); }
});

it('falls back to fresh tombstoned PDFs after a cached upload leaves an unreadable reservation', async () => {
  const f = await fixture();
  try {
    const gym = f.gyms[0]!, prefix = `${gym.gymId}/waivers/${gym.member.id}/`;
    const cached = gym.signature.signatureImageKey.replace('/signatures/', '/pdf/').replace(/\.png$/, '.pdf');
    const blob = `/waivers/${gym.gymId}/.storage/blobs/${createHash('sha256').update(cached).digest('hex')}`;
    f.s3.failOnce((method, url) => method === 'PUT' && url.pathname === blob && url.searchParams.has('uploadId') && url.searchParams.has('partNumber'));
    const expected = Buffer.from(await renderWaiver(gym.signature.snapshot, gym.signature.snapshotHash, demoSignaturePng()));
    const first = await link(await pdfRequest(f));
    expect(f.s3.state.aborted).toBe(1); expect(f.render).toHaveBeenCalledTimes(1);
    const uploads = await f.uploads.forGym(gym.gymId);
    expect(await uploads.head(cached)).toBeNull();
    const before = f.s3.methods.length;
    const second = await link(await pdfRequest(f));
    expect(writes(f.s3.methods.slice(before))).toHaveLength(7);
    expect(f.render).toHaveBeenCalledTimes(2);
    expect(new URL(first.url).pathname).not.toBe(new URL(second.url).pathname);
    for (const data of [first, second]) {
      expect(data.expiresAt).toBe('2026-10-25T12:05:00.000Z');
      const response = await fetch(data.url); expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
    }
    const pdfs = (await uploads.list(prefix)).filter(file => file.contentType === 'application/pdf');
    expect(pdfs).toHaveLength(2); expect(pdfs.every(file => file.deletedAt)).toBe(true);
    const photos = createMemberPhotoService(createMembersService({ scope: db.forGym, clock: f.clock }), f.uploads.forGym);
    await photos.anonymize(gym.ctx, gym.member.id, gym.member.revision);
    expect((await pdfRequest(f)).status).toBe(404);
    expect((await uploads.list(prefix)).every(file => file.deletedAt)).toBe(true);
  } finally { await f.close(); }
});

it('limits each sandbox to ten PDF requests per minute across client addresses, before rendering or storage', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10; i++) await link(await pdfRequest(f, f.gyms[0], `192.0.2.${i + 1}`));
    const before = f.s3.methods.length;
    const blocked = await pdfRequest(f, f.gyms[0], '198.51.100.1');
    expect(blocked.status).toBe(429); expect(blocked.headers.get('Retry-After')).toBe('60');
    expect(f.s3.methods).toHaveLength(before); expect(f.render).toHaveBeenCalledTimes(1);
    await link(await pdfRequest(f, f.gyms[1]));
    expect((await f.app.request(f.gyms[0]!.origin + '/api/waivers/signatures')).status).toBe(200);
    f.clock.advance(59_999);
    const almost = await pdfRequest(f); expect(almost.status).toBe(429); expect(almost.headers.get('Retry-After')).toBe('1');
    f.clock.advance(1);
    const cached = f.s3.methods.length;
    await link(await pdfRequest(f));
    expect(writes(f.s3.methods.slice(cached))).toEqual([]); expect(f.render).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});

it('refuses every visitor put and erases cached PDFs with their signature images through the existing erasure service', async () => {
  const f = await fixture();
  try {
    const gym = f.gyms[0]!, url = (await link(await pdfRequest(f))).url;
    const uploads = await f.uploads.forGym(gym.gymId), before = f.s3.methods.length;
    for (const key of [gym.signature.signatureImageKey, `${gym.gymId}/waivers/${gym.member.id}/pdf/${uuidv7()}.pdf`])
      await expect(uploads.put(key, new Uint8Array([1]), 'application/pdf')).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.s3.methods).toHaveLength(before);
    const members = createMembersService({ scope: db.forGym, clock: f.clock });
    const photos = createMemberPhotoService(members, f.uploads.forGym);
    await photos.anonymize(gym.ctx, gym.member.id, gym.member.revision);
    expect((await pdfRequest(f)).status).toBe(404);
    const files = await uploads.list();
    expect(files.filter(file => file.contentType === 'application/pdf')).toHaveLength(1);
    expect(files.every(file => file.deletedAt)).toBe(true);
    expect((await fetch(url)).status).toBe(200); // Already issued links retain their expiry window.
    await uploads.sweep({ before: new Date('9999-01-01T00:00:00Z') });
    expect((await fetch(url)).status).toBe(404);
  } finally { await f.close(); }
});

it('does not publish a PDF or fresh link when the member is erased during rendering', async () => {
  const f = await fixture();
  try {
    const gym = f.gyms[0]!, members = createMembersService({ scope: db.forGym, clock: f.clock });
    const photos = createMemberPhotoService(members, f.uploads.forGym);
    configureWaivers({ scope: db.forGym, clock: f.clock, uploadsFor: f.uploads.forGym, render: async (...args) => {
      await photos.anonymize(gym.ctx, gym.member.id, gym.member.revision);
      return renderWaiver(...args);
    } });
    expect((await pdfRequest(f)).status).toBe(404);
    const files = await (await f.uploads.forGym(gym.gymId)).list();
    expect(files.filter(file => file.contentType === 'application/pdf')).toEqual([]);
    expect(files.every(file => file.deletedAt)).toBe(true);
  } finally { await f.close(); }
});

it('keeps production PDF rendering, fresh tombstoned copies and downloads beyond ten unchanged', async () => {
  const f = await fixture(false);
  try {
    const keys = new Set<string>();
    for (let i = 0; i < 11; i++) keys.add(new URL((await link(await pdfRequest(f))).url).pathname);
    expect(keys.size).toBe(11); expect(f.render).toHaveBeenCalledTimes(11);
    const files = await (await f.uploads.forGym(f.gyms[0]!.gymId)).list();
    const pdfs = files.filter(file => file.contentType === 'application/pdf');
    expect(pdfs).toHaveLength(11); expect(pdfs.every(file => file.deletedAt)).toBe(true);
  } finally { await f.close(); }
});
