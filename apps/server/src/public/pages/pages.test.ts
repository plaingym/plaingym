// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { auditEvents, members, households, waiverSignatures, waiverTemplates, invoices, leads, uuidv7 } from '@plaingym/db';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { publicContracts, publicSubmissionResponseSchema } from '@plaingym/shared/contracts';
import { createApp } from '../../app.js';
import { areaContributions } from '../../core/registry-areas.js';
import { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import { authorize } from '../../areas/staff/auth.permissions.js';
import { createSettingsService } from '../../areas/settings/settings.js';
import { createWaiversService } from '../../areas/waivers/waivers.js';
import { createWaiverDocumentDelivery } from '../../areas/waivers/document-delivery.js';
import { waiverDocumentFixture } from '../../areas/waivers/document.fixture.js';
import { documentReadBudget } from '../../areas/waivers/document-read.js';
import { readSnapshot } from '../../areas/waivers/snapshot.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { demoUploads } from '../../demo/uploads.js';
import { demoSignatureReservation } from '../../demo/waiver-signatures.js';
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';
import { configurePublicPages, createPublicRoutes } from './pages.routes.js';
import { logoVersion } from '../short-hash.js';
import { configureSharedRateLimits } from '../../core/rate-limit.js';
import { createIntakeRateLimitStore } from '../../core/rate-limit-store.js';
import { publicIntakeLimits } from '../../core/rate-limit-intake.js';
import { createDropInCleanup, dropInAdmissionWindowMs, dropInCleanupJob } from './pages.cleanup.js';

const db = useTestDatabase(), factory = createFactories(db), png = demoSignaturePng();
const origin = 'https://gym.example.test';
const body = (email = 'visitor@example.invalid') => ({ contact: { name: 'Alex Contact', email },
  member: { firstName: 'New', lastName: 'Visitor', dateOfBirth: '1990-01-02' }, honeypot: '' });
async function fixture(demo = false) {
  const gymId = uuidv7(), otherGym = uuidv7(), clock = new TestClock('2026-10-29T12:00:00Z');
  await factory('gyms', gymId, { name: 'North <Gym>', websiteEnabled: false, address: { line1: '12 Mat Street', city: 'Vancouver' },
    settings: { modules: { website: { phone: '+1 (604) 555-0100', email: 'hello@north.example.test', secret: 'Not public' } } },
    branding: { primaryColor: '#ffff00', logoKey: gymId + '/logo.png' } });
  await factory('gyms', otherGym, { name: 'Other private gym', branding: { primaryColor: '#000080' } });
  const existingHome = await factory('households', gymId, { name: 'Existing household', email: 'existing@example.invalid' });
  const existing = await factory('members', gymId, { householdId: existingHome.id, status: 'active', email: 'existing@example.invalid', firstName: 'Private Member' });
  const sibling = await factory('members', gymId, { householdId: existingHome.id, firstName: 'Private Sibling', status: 'active' });
  const template = await factory('waiverTemplates', gymId, { name: 'Participation', body: 'I understand the training risks. <script>bad()</script>' });
  const secondTemplate = await factory('waiverTemplates', gymId, { name: 'Conduct', body: 'I agree to follow the rules.', kind: 'agreement' });
  const foreignTemplate = await factory('waiverTemplates', otherGym, { name: 'Private other gym terms' });
  const uploads = new Map([gymId, otherGym].map(id => [id, new FakeUploads(id, clock)]));
  await uploads.get(gymId)!.put(gymId + '/logo.png', png, 'image/png');
  const uploadsFor = async (id: string) => demo ? demoUploads(uploads.get(id)!) : uploads.get(id)!;
  const documentDelivery = createWaiverDocumentDelivery({ uploadsFor, clock, key: new Uint8Array(32).fill(8), originFor: async () => origin });
  const waivers = createWaiversService({ scope: db.forGym, clock, uploadsFor, documentDelivery });
  // The staff-notice hook the runtime gives the public pages (it queues the notice after commit).
  const notices: { gymId: string; kind: string; memberId: string }[] = [];
  const service = configurePublicPages({ scope: db.forGym, clock, waivers, uploadsFor,
    stylesheet: async () => '/* shared css */',
    dropInFeeFor: async id => id === gymId ? { amountCents: 2500, currency: 'CAD', plusTax: false } : null,
    notifyStaff: async (id, intake) => { notices.push({ gymId: id, kind: intake.kind, memberId: intake.memberId }); } });
  const app = (resolved = gymId, principal: Principal = { kind: 'anonymous' }) => createApp({ skipSetup: true, clock, authorize,
    contributions: areaContributions, origin, rateLimit: { limit: 10_000 },
    resolveGym: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), gym: { gymId: resolved, timezone: 'America/Vancouver', enabledModules: new Set() } }); await next(); },
    session: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), principal }); await next(); } });
  const server = app();
  const post = (path: string, input: unknown, target = server) => target.request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const admission = (input = body()) => ({ ...input, signatures: [template, secondTemplate].map(t => ({ templateId: t.id, templateVersion: t.version, pngBase64: png.toString('base64') })) });
  async function admit(input = body()) {
    const response = await post('/drop-in/signatures', admission(input)); expect(response.status).toBe(200);
    const images = await response.json() as { data: { templateId: string; templateVersion: number; signatureImageKey: string; signatureImageHash: string }[] };
    return { ...input, waivers: images.data.map(image => ({ ...image, signer: { kind: 'self' as const, name: 'New Visitor' }, consent: true as const })) };
  }
  const rows = () => db.forGym(gymId, async tx => ({ members: await tx.select().from(members), homes: await tx.select().from(households),
    signatures: await tx.select().from(waiverSignatures), audits: await tx.select().from(auditEvents), invoices: await tx.select().from(invoices), leads: await tx.select().from(leads) }));
  return { gymId, otherGym, clock, existing, existingHome, sibling, template, secondTemplate, foreignTemplate, waivers, uploads, notices, service, app, server, post, admission, admit, rows };
}

describe('core public pages through the production registrations', () => {
  it('resolves storage once across the drop-in cleanup run', async () => {
    const f = await fixture(); await f.admit(); await f.admit(body('second@example.invalid'));
    const uploadsFor = vi.fn(async () => f.uploads.get(f.gymId)!);
    const cleanup = createDropInCleanup({ scope: db.forGym, clock: f.clock, uploadsFor });
    f.clock.advance(dropInAdmissionWindowMs);
    expect(await cleanup.run(f.gymId)).toBe(2); expect(uploadsFor).toHaveBeenCalledTimes(1);
    expect(await cleanup.run(f.gymId)).toBe(0); expect(uploadsFor).toHaveBeenCalledTimes(1);
  });

  it('lets only the same partially signed admission finish after expiry, including after cleanup retains it', async () => {
    const f = await fixture(), partial = await f.admit(), unsigned = await f.admit(body('unsigned@example.invalid'));
    const id = partial.waivers[0]!.signatureImageKey.split('/')[2]!;
    await f.waivers.sign({ gymId: f.gymId, actor: { kind: 'system' } }, { ...partial.waivers[0]!, memberId: id },
      { timezone: 'America/Vancouver', ipAddress: '192.0.2.1' });
    f.clock.advance(dropInAdmissionWindowMs + 1);
    expect((await f.post('/api/public/drop-in', unsigned)).status).toBe(404);
    expect((await f.post('/api/public/drop-in', partial, f.app(f.otherGym))).status).toBe(404);
    expect((await f.post('/api/public/drop-in', { ...partial, contact: { ...partial.contact, email: 'somebody@example.invalid' } })).status).toBe(404);
    expect((await f.post('/api/public/drop-in', { ...partial, member: { ...partial.member, firstName: 'Somebody' } })).status).toBe(404);
    // An unsigned staff upload cannot stand in for the original signed capability to extend the window.
    const staff = await f.waivers.uploadSignature({ gymId: f.gymId, actor: { kind: 'system' } }, id, png);
    expect((await f.post('/api/public/drop-in', { ...partial, waivers: partial.waivers.map(w => ({ ...w, ...staff })) })).status).toBe(404);
    expect(await f.service.cleanup!.run(f.gymId)).toBe(1);
    expect((await f.post('/api/public/drop-in', partial)).status).toBe(200);
    expect((await f.post('/api/public/drop-in', partial)).status).toBe(200);
    expect((await f.rows()).signatures).toHaveLength(2); expect(f.notices).toHaveLength(1);
    for (const image of partial.waivers) expect((await f.uploads.get(f.gymId)!.head(image.signatureImageKey))!.deletedAt).toBeUndefined();
  });

  it('uses the short busy retry for counter failures across trial, drop-in and native forms', async () => {
    const f = await fixture(), store = createIntakeRateLimitStore(db.forSystem);
    vi.spyOn(store, 'reserve').mockImplementation(async ({ now }) => ({ allowed: false, resetAt: now + 3_600_000, failed: true }));
    const reset = configureSharedRateLimits(store);
    try {
      for (const path of ['/api/public/trial', '/drop-in/signatures']) {
        const reply = await f.post(path, path.includes('signatures') ? f.admission() : body());
        expect(reply.status).toBe(429); expect(reply.headers.get('retry-after')).toBe('1');
        expect(await reply.json()).toMatchObject({ error: { message: expect.stringContaining('Wait a moment'), details: { reason: ['busy'] } } });
      }
      const trial = new URLSearchParams({ firstName: 'New', lastName: 'Visitor', dateOfBirth: '1990-01-02', contactName: 'Alex Contact', email: 'native@example.invalid', honeypot: '' });
      const native = await f.server.request(origin + '/trial', { method: 'POST', headers: { origin }, body: trial });
      expect(native.status).toBe(429); expect(native.headers.get('retry-after')).toBe('1'); expect(await native.text()).toContain('Wait a moment');
      const dropIn = new FormData(); for (const [key, value] of trial) dropIn.set(key, value);
      for (const [i, template] of (await f.service.required(f.gymId)).entries()) {
        for (const [key, value] of Object.entries({ template: template.id, version: String(template.version), kind: 'self', name: 'New Visitor', consent: 'on' }))
          dropIn.set(`waiver-${i}-${key}`, value);
        dropIn.set(`waiver-${i}-image`, new File([new Uint8Array(png)], 'signature.png', { type: 'image/png' }));
      }
      const nativeDropIn = await f.server.request(origin + '/drop-in', { method: 'POST', headers: { origin }, body: dropIn });
      expect(nativeDropIn.status).toBe(429); expect(nativeDropIn.headers.get('retry-after')).toBe('1'); expect(await nativeDropIn.text()).toContain('Wait a moment');
      expect((await f.rows()).members).toHaveLength(2);
    } finally { reset(); }
  });

  it('cleans expired abandoned admissions through the registered batch job while keeping completed visits', async () => {
    const f = await fixture(), abandoned = await f.admit(), completed = await f.admit(body('completed@example.invalid'));
    expect((await f.post('/api/public/drop-in', completed)).status).toBe(200);
    const id = abandoned.waivers[0]!.signatureImageKey.split('/')[2]!;
    const home = (await f.rows()).members.find(m => m.id === id)!.householdId;
    f.clock.advance(dropInAdmissionWindowMs - 1);
    expect(await f.service.cleanup!.run(f.gymId)).toBe(0);
    f.clock.advance(1);
    const job = areaContributions.jobs.find(job => job.id === dropInCleanupJob)!;
    expect(job).toMatchObject({ cron: '41 3 * * *', lane: 'batch' });
    await job.handler({}, { gymId: f.gymId, clock: f.clock, timezone: 'America/Vancouver', jobId: uuidv7(), attempt: 1 });
    const rows = await f.rows();
    expect(rows.members.some(m => m.id === id)).toBe(false);
    expect(rows.homes.some(h => h.id === home)).toBe(false);
    expect(rows.leads.some(l => l.memberId === id)).toBe(false);
    for (const image of abandoned.waivers) expect((await f.uploads.get(f.gymId)!.head(image.signatureImageKey))!.deletedAt).toBeDefined();
    for (const image of completed.waivers) expect((await f.uploads.get(f.gymId)!.head(image.signatureImageKey))!.deletedAt).toBeUndefined();
    expect(rows.signatures).toHaveLength(2);
    expect((await f.post('/api/public/drop-in', completed)).status).toBe(200);
    expect(await f.service.cleanup!.run(f.gymId)).toBe(0);
  });

  it('keeps partially signed admissions and prospects or leads staff have changed', async () => {
    const f = await fixture(), partial = await f.admit(), edited = await f.admit(), contacted = await f.admit();
    const partialId = partial.waivers[0]!.signatureImageKey.split('/')[2]!;
    await f.waivers.sign({ gymId: f.gymId, actor: { kind: 'system' } }, { ...partial.waivers[0]!, memberId: partialId },
      { timezone: 'America/Vancouver', ipAddress: '192.0.2.1' });
    const editedId = edited.waivers[0]!.signatureImageKey.split('/')[2]!, contactedId = contacted.waivers[0]!.signatureImageKey.split('/')[2]!;
    await db.forGym(f.gymId, async tx => {
      await tx.update(members).set({ revision: 2 }).where(eq(members.id, editedId));
      await tx.update(leads).set({ stage: 'contacted', revision: 2 }).where(eq(leads.memberId, contactedId));
    });
    f.clock.advance(dropInAdmissionWindowMs);
    expect(await f.service.cleanup!.run(f.gymId)).toBe(0);
    for (const request of [partial, edited, contacted]) for (const image of request.waivers)
      expect((await f.uploads.get(f.gymId)!.head(image.signatureImageKey))!.deletedAt).toBeUndefined();
    expect((await f.rows()).audits.filter(a => a.action === 'public.drop_in.retained')).toHaveLength(3);
  });

  it('keeps abandoned admissions staff checked in or tagged instead of failing on their references', async () => {
    const f = await fixture(), checkedIn = await f.admit(), tagged = await f.admit();
    const checkedInId = checkedIn.waivers[0]!.signatureImageKey.split('/')[2]!, taggedId = tagged.waivers[0]!.signatureImageKey.split('/')[2]!;
    await factory('attendances', f.gymId, { memberId: checkedInId, kind: 'open_mat' });
    const tag = await factory('memberTags', f.gymId);
    await factory('memberTagLinks', f.gymId, { memberId: taggedId, tagId: tag.id });
    f.clock.advance(dropInAdmissionWindowMs);
    expect(await f.service.cleanup!.run(f.gymId)).toBe(0);
    const rows = await f.rows();
    expect(rows.members.filter(m => [checkedInId, taggedId].includes(m.id))).toHaveLength(2);
    expect(rows.audits.filter(a => a.action === 'public.drop_in.retained')).toHaveLength(2);
    for (const request of [checkedIn, tagged]) for (const image of request.waivers)
      expect((await f.uploads.get(f.gymId)!.head(image.signatureImageKey))!.deletedAt).toBeUndefined();
  });

  it('retries interrupted image deletion after the durable claim and continues other admissions', async () => {
    const f = await fixture(), first = await f.admit(), second = await f.admit();
    const uploads = f.uploads.get(f.gymId)!, erase = vi.spyOn(uploads, 'markDeleted').mockRejectedValueOnce(new Error('storage unavailable'));
    f.clock.advance(dropInAdmissionWindowMs);
    await expect(f.service.cleanup!.run(f.gymId)).rejects.toThrow('storage unavailable');
    expect((await f.rows()).members).toHaveLength(2); // Only the original household's members remain.
    expect((await f.rows()).audits.filter(a => a.action === 'public.drop_in.cleaned')).toHaveLength(1);
    expect(await f.service.cleanup!.run(f.gymId)).toBe(1);
    expect((await f.rows()).audits.filter(a => a.action === 'public.drop_in.cleanup.started')).toHaveLength(2);
    for (const image of [...first.waivers, ...second.waivers]) expect((await uploads.head(image.signatureImageKey))!.deletedAt).toBeDefined();
    erase.mockRestore();
  });

  it('keeps images when an in-progress final submission crosses the cleanup boundary', async () => {
    const f = await fixture(), input = await f.admit();
    let resume!: () => void, signed!: () => void;
    const wait = new Promise<void>(resolve => { resume = resolve; }), started = new Promise<void>(resolve => { signed = resolve; });
    const sign = f.waivers.sign.bind(f.waivers);
    const spy = vi.spyOn(f.waivers, 'sign').mockImplementationOnce(async (...args) => {
      const result = await sign(...args); signed(); await wait; return result;
    });
    const completing = f.post('/api/public/drop-in', input);
    try {
      await started;
      f.clock.advance(dropInAdmissionWindowMs);
      expect(await f.service.cleanup!.run(f.gymId)).toBe(0);
    } finally { resume(); spy.mockRestore(); }
    expect((await completing).status).toBe(200);
    expect((await f.rows()).signatures).toHaveLength(2);
    for (const image of input.waivers) expect((await f.uploads.get(f.gymId)!.head(image.signatureImageKey))!.deletedAt).toBeUndefined();
  });

  it('serializes concurrent cleanup claims without updating the append-only audit table', async () => {
    const f = await fixture(), input = await f.admit(), id = input.waivers[0]!.signatureImageKey.split('/')[2]!;
    f.clock.advance(dropInAdmissionWindowMs);
    await Promise.all([f.service.cleanup!.remove(f.gymId, id), f.service.cleanup!.remove(f.gymId, id)]);
    const rows = await f.rows();
    expect(rows.members.some(m => m.id === id)).toBe(false);
    expect(rows.audits.filter(a => a.action === 'public.drop_in.cleanup.started')).toHaveLength(1);
    expect(rows.audits.filter(a => a.action === 'public.drop_in.retained')).toHaveLength(0);
    for (const image of input.waivers) expect((await f.uploads.get(f.gymId)!.head(image.signatureImageKey))!.deletedAt).toBeDefined();
  });

  it('isolates cleanup by gym and refuses an expired admission before signing even before cleanup runs', async () => {
    const f = await fixture(), input = await f.admit(), id = input.waivers[0]!.signatureImageKey.split('/')[2]!;
    f.clock.advance(dropInAdmissionWindowMs);
    expect(await f.service.cleanup!.remove(f.otherGym, id)).toBe(false);
    expect(await f.service.cleanup!.run(f.otherGym)).toBe(0);
    expect((await f.post('/api/public/drop-in', input)).status).toBe(404);
    expect((await f.rows()).signatures).toHaveLength(0);
    expect(await f.service.cleanup!.remove(f.gymId, id)).toBe(true);
  });

  it('refuses new trial and drop-in admissions at the shared ceiling with page text while an existing visit finishes', async () => {
    const f = await fixture(), existing = await f.admit(), store = createIntakeRateLimitStore(db.forSystem);
    await store.consume({ gymId: f.gymId, routeKey: 'public.intake.participants', clientKey: '*', now: f.clock.now().getTime(),
      windowMs: publicIntakeLimits.windowMs, limit: publicIntakeLimits.participants, amount: publicIntakeLimits.participants });
    const reset = configureSharedRateLimits(store);
    try {
      for (const path of ['/api/public/trial', '/drop-in/signatures']) {
        const reply = await f.post(path, path.includes('signatures') ? f.admission() : body());
        expect(reply.status).toBe(429); expect(reply.headers.get('retry-after')).toBe('3600');
        expect(await reply.json()).toMatchObject({ error: { code: 'rate_limited', message: expect.stringContaining('online forms are busy') } });
      }
      const form = new URLSearchParams({ firstName: 'New', lastName: 'Visitor', dateOfBirth: '1990-01-02', contactName: 'Alex Contact', email: 'native@example.invalid', honeypot: '' });
      const native = await f.server.request(origin + '/trial', { method: 'POST', headers: { origin }, body: form });
      expect(native.status).toBe(429); expect(await native.text()).toContain('online forms are busy');
      expect((await f.post('/api/public/drop-in', existing)).status).toBe(200);
      expect((await f.post('/api/public/trial', body(), f.app(f.otherGym))).status).toBe(200);
    } finally { reset(); }
  });

  it('accepts a drop-in address with unknown stored keys while checking known fields', async () => {
    const f = await fixture(), input = await f.admit();
    const memberId = input.waivers[0]!.signatureImageKey.split('/')[2]!, before = await f.rows();
    const person = before.members.find(m => m.id === memberId)!;
    await db.forGym(f.gymId, tx => tx.update(households).set({ address: { future: true } }).where(eq(households.id, person.householdId)));
    expect((await f.post('/api/public/drop-in', { ...input, contact: { ...input.contact, address: { city: 'Different' } } })).status).toBe(404);
    expect((await f.post('/api/public/drop-in', input)).status).toBe(200);
    expect((await f.post('/api/public/drop-in', input)).status).toBe(200);
  });

  it('renders branded pages with the website off, escaped terms, CSP, fee and source link', async () => {
    const f = await fixture();
    for (const path of ['/trial', '/drop-in', '/trial/received', '/drop-in/received']) {
      const response = await f.server.request(origin + path), html = await response.text();
      expect(response.status).toBe(200); expect(html).toContain('North &lt;Gym&gt;');
      expect(html).toContain('<html lang="en" class="theme-system">');
      expect(html).toContain('name="color-scheme" content="light dark"');
      expect(html).toContain('12 Mat Street'); expect(html).toContain('href="tel:+16045550100"');
      expect(html).toContain('href="mailto:hello@north.example.test"'); expect(html).not.toContain('Not public');
      expect(html).toContain('href="/source"'); expect(html).toContain('aria-label="Version '); expect(html).not.toContain('Private Member');
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(response.headers.get('content-security-policy')).toMatch(/; report-uri \/csp-report; report-to csp$/);
      expect(response.headers.get('reporting-endpoints')).toBe('csp="/csp-report"');
      expect(response.headers.get('cache-control')).toBe('no-store');
      if (path === '/drop-in') { expect(html).toContain('$25.00'); expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;'); expect(html).not.toContain('<script>bad()'); }
    }
    const theme = await f.server.request(origin + '/public/pages/theme.css');
    expect(await theme.text()).toMatch(/^:root\{--color-primary:#9a9a00;--color-primary-foreground:#000000\}/);
    const settings = createSettingsService({ scope: db.forGym, clock: f.clock });
    expect((await settings.get(f.gymId)).branding.primaryColor).toBe('#ffff00');
    const primaryColor = '#08152e';
    await settings.update({ gymId: f.gymId, actor: { kind: 'system' } }, 'general', { revision: 1, branding: { primaryColor } });
    expect(await (await f.server.request(origin + '/public/pages/theme.css')).text()).toMatch(/^:root\{--color-primary:#08152e;[^}]+\}@media screen\{\.dark\{--color-primary:(?!#08152e)/);
    expect((await settings.get(f.gymId)).branding.primaryColor).toBe(primaryColor);
    expect((await f.server.request(origin + '/public/pages/client.js')).headers.get('content-type')).toContain('text/javascript');
    expect(await (await f.server.request(origin + '/public/pages/styles.css')).text()).toContain('shared css');
  });
  it('projects only the resolved gym config, templates, color and logo, across every read route', async () => {
    const f = await fixture(), other = f.app(f.otherGym);
    for (const path of ['/trial', '/drop-in', '/trial/received', '/drop-in/received', '/api/public/config', '/api/public/waivers', '/public/pages/theme.css']) {
      const response = await other.request(origin + path), text = await response.text();
      expect(response.status).toBe(200); expect(text).not.toContain('North'); expect(text).not.toContain(f.template.id); expect(text).not.toContain('#ffff00');
      if (path === '/public/pages/theme.css') expect(text).not.toContain('#9a9a00');
      expect(text).not.toContain('12 Mat Street'); expect(text).not.toContain('hello@north.example.test');
    }
    const path = origin + '/public/pages/logo/' + logoVersion(f.gymId + '/logo.png');
    expect((await other.request(path)).status).toBe(404);
    const image = await f.server.request(path);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await f.server.request(origin + '/public/pages/logo/1')).status).toBe(400);
    expect((await f.server.request(origin + '/public/pages/logo/' + logoVersion('old-logo'))).status).toBe(404);
    await expect(f.service.logo(f.gymId, '1')).rejects.toMatchObject({ code: 'not_found' });
    expect(await (await f.server.request(origin + '/trial')).text()).toContain(`src="/public/pages/logo/${logoVersion(f.gymId + '/logo.png')}"`);
    const config = await (await f.server.request(origin + '/api/public/config')).json();
    expect(publicContracts.config.response.parse(config).data.dropInFee).toEqual({ amountCents: 2500, currency: 'CAD', plusTax: false });
    const page = await (await f.server.request(origin + '/api/public/waivers?limit=1&offset=1')).json();
    expect(publicContracts.waivers.response.parse(page).pagination).toEqual({ limit: 1, offset: 1, total: 2 });
    expect(JSON.stringify(config)).not.toMatch(/stripe|smtp|billingEnabled/);
  });
  it('keeps new, existing and enrolled emails indistinguishable without editing existing households', async () => {
    const f = await fixture();
    const fresh = await f.post('/api/public/trial', body()), existing = await f.post('/api/public/trial', body('existing@example.invalid'));
    expect(existing.status).toBe(fresh.status); expect(await existing.json()).toEqual(await fresh.json());
    for (const header of ['content-type', 'cache-control', 'content-security-policy']) expect(existing.headers.get(header)).toBe(fresh.headers.get(header));
    const rows = await f.rows(); expect(rows.members.filter(m => m.status === 'prospect')).toHaveLength(2);
    expect(rows.members.find(m => m.id === f.existing.id)).toMatchObject({ status: 'active', firstName: 'Private Member', revision: 1 });
    expect(rows.homes.find(h => h.id === f.existingHome.id)).toMatchObject({ name: 'Existing household', revision: 1 });
    expect(f.notices).toHaveLength(2); expect(f.notices.every(n => n.gymId === f.gymId && n.kind === 'trial')).toBe(true);
    expect(rows.audits.filter(a => a.action === 'public.trial.received')).toHaveLength(2);
    expect(rows.leads).toHaveLength(2);
    expect(rows.leads.every(l => l.source === 'trial_form' && l.stage === 'new' && l.createdAt.getTime() === f.clock.now().getTime())).toBe(true);
    expect(rows.leads.map(l => l.memberId).sort()).toEqual(rows.members.filter(m => m.status === 'prospect').map(m => m.id).sort());
    expect(rows.audits.filter(a => a.action === 'lead.created')).toHaveLength(2);
    expect(JSON.stringify(rows.audits)).not.toContain('existing@example.invalid');
  });
  it('rejects bots on JSON, admission and native forms before writing or sending mail', async () => {
    const f = await fixture(), before = await f.rows();
    for (const path of ['/api/public/trial', '/api/public/drop-in', '/drop-in/signatures']) {
      const input = path === '/drop-in/signatures' ? f.admission() : body();
      expect((await f.post(path, { ...input, honeypot: 'bot' })).status).toBe(400);
    }
    const form = new URLSearchParams({ firstName: 'Bot', lastName: 'Person', dateOfBirth: '1990-01-01', contactName: 'Bot', email: 'bot@example.invalid', honeypot: 'bot' });
    expect((await f.server.request(origin + '/trial', { method: 'POST', headers: { origin }, body: form })).status).toBe(400);
    expect((await f.rows()).members).toHaveLength(before.members.length); expect(f.notices).toHaveLength(0);
  });
  it('limits failed validation before parsing, shares native/JSON budgets, and recovers with the core clock', async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++) expect((await f.post('/api/public/trial', {})).status).toBe(400);
    const limited = await f.post('/api/public/drop-in', {}); expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('900');
    expect((await f.server.request(origin + '/trial', { method: 'POST', headers: { origin }, body: new URLSearchParams() })).status).toBe(429);
    expect((await f.post('/api/public/trial', body(), f.app(f.otherGym))).status).toBe(200);
    f.clock.advance(15 * 60_000); expect((await f.post('/api/public/trial', body())).status).toBe(200);
  });
  it('allows public access for anonymous and each staff role while private APIs remain protected', async () => {
    const f = await fixture();
    expect(createPublicRoutes().every(r => r.definition.permission.kind === 'public')).toBe(true);
    for (const role of ['owner', 'admin', 'coach', 'front_desk'] as const) {
      const server = f.app(f.gymId, { kind: 'staff', gymId: f.gymId, userId: uuidv7(), roles: [role] });
      expect((await server.request(origin + '/trial')).status).toBe(200);
      expect((await f.post('/api/public/trial', body(), server)).status).toBe(200);
    }
    expect((await f.server.request(origin + '/api/members')).status).toBe(401);
    expect((await f.post('/api/public/trial', { ...body(), householdId: f.existingHome.id, status: 'active' })).status).toBe(400);
  });
  it.each([false, true])('signs immutable waivers and replays without duplicate visitors (PDF: %s)', async pdfTemplate => {
    const f = await fixture();
    if (pdfTemplate) {
      const document = await f.waivers.uploadDocument({ gymId: f.gymId, actor: { kind: 'system' } }, await waiverDocumentFixture());
      await db.forGym(f.gymId, tx => tx.update(waiverTemplates).set({ body: '', documentKey: document.key, documentHash: document.hash, documentPages: document.pages, documentBytes: document.bytes }).where(eq(waiverTemplates.id, f.template.id)));
      const documentPath = `/api/public/waivers/${f.template.id}/document`;
      for (let i = 0; i < 20; i++) expect((await f.server.request(origin + documentPath + '?view=1')).status).toBe(302);
      for (let i = 20; i < documentReadBudget; i++) expect((await f.server.request(origin + documentPath)).status).toBe(200);
      const refused = await f.server.request(origin + documentPath + '?view=1');
      expect(refused.status).toBe(429); expect(refused.headers.get('retry-after')).toBe('60');
      expect(refused.headers.get('content-type')).toContain('text/html');
      const html = await refused.text();
      expect(html).toContain('Wait a minute');
      expect(html).toContain('<html lang="en">');
      expect(html).not.toContain('name="color-scheme"');
      expect((await f.app(f.otherGym).request(origin + documentPath)).status).toBe(404);
      expect(await (await f.server.request(origin + '/drop-in')).text()).toContain('Open the document');
    }
    const input = await f.admit();
    const admittedLeads = (await f.rows()).leads;
    expect(admittedLeads).toHaveLength(1);
    expect(admittedLeads[0]).toMatchObject({ memberId: input.waivers[0]!.signatureImageKey.split('/')[2], source: 'drop_in', stage: 'new' });
    expect((await f.rows()).members.find(m => m.id === input.waivers[0]!.signatureImageKey.split('/')[2])!.status).toBe('prospect');
    const response = await f.post('/api/public/drop-in', input); expect(response.status).toBe(200);
    expect(publicSubmissionResponseSchema.parse(await response.json())).toEqual({ data: { status: 'received' } });
    expect((await f.post('/api/public/drop-in', input)).status).toBe(200);
    const rows = await f.rows(); expect(rows.members.filter(m => m.status === 'visitor')).toHaveLength(1); expect(rows.signatures).toHaveLength(2); expect(rows.invoices).toHaveLength(0);
    expect(readSnapshot(rows.signatures[0]!.snapshot, rows.signatures[0]!.snapshotHash).member.firstName).toBe('New');
    expect(f.notices).toHaveLength(1); expect(rows.audits.filter(a => a.action === 'public.drop_in.received')).toHaveLength(1);
    expect(rows.leads).toEqual(admittedLeads);
    expect(rows.audits.filter(a => a.action === 'lead.created')).toHaveLength(1);
  });
  it('responds identically to new and enrolled drop-ins and does not touch the enrolled member or sibling', async () => {
    const f = await fixture(), fresh = await f.admit(), existing = await f.admit(body('existing@example.invalid'));
    const a = await f.post('/api/public/drop-in', fresh), b = await f.post('/api/public/drop-in', existing);
    expect(a.status).toBe(200); expect(b.status).toBe(200); expect(await a.json()).toEqual(await b.json());
    const rows = await f.rows(); expect(rows.signatures.every(s => s.memberId !== f.existing.id && s.memberId !== f.sibling.id)).toBe(true);
    expect(rows.members.find(m => m.id === f.existing.id)!.status).toBe('active');
  });
  it('refuses forged household IDs, foreign gym images/templates, and another intake applicant', async () => {
    const f = await fixture(), input = await f.admit(), other = f.app(f.otherGym);
    expect((await f.post('/api/public/drop-in', input, other)).status).toBe(404);
    expect((await f.post('/drop-in/signatures', f.admission(), other)).status).toBe(404);
    expect((await f.post('/api/public/drop-in', { ...input, householdId: f.existingHome.id })).status).toBe(400);
    expect((await f.post('/api/public/drop-in', { ...input, contact: { ...input.contact, email: 'somebody@example.invalid' } })).status).toBe(404);
    expect((await f.post('/api/public/drop-in', { ...input, member: { ...input.member, firstName: 'Private Member' } })).status).toBe(404);
    expect((await f.post('/api/public/drop-in', { ...input, waivers: input.waivers.map(w => ({ ...w, templateId: f.foreignTemplate.id })) })).status).toBe(404);
    expect((await f.rows()).signatures).toHaveLength(0);
  });
  it('cannot use staff-uploaded images to sign for an existing household', async () => {
    const f = await fixture(), image = await f.waivers.uploadSignature({ gymId: f.gymId, actor: { kind: 'system' } }, f.existing.id, png);
    const input = { ...body('existing@example.invalid'), waivers: [f.template, f.secondTemplate].map(t => ({ ...image, templateId: t.id, templateVersion: t.version, signer: { kind: 'self', name: 'Forged' }, consent: true })) };
    expect((await f.post('/api/public/drop-in', input)).status).toBe(404); expect((await f.rows()).signatures).toHaveLength(0);
  });
  it('requires a guardian for minors, consent, every current document and exact template versions', async () => {
    const f = await fixture(), child = { ...body(), member: { ...body().member, dateOfBirth: '2018-01-01' } }, input = await f.admit(child);
    expect((await f.post('/api/public/drop-in', input)).status).toBe(400);
    expect((await f.post('/api/public/drop-in', { ...input, waivers: input.waivers.slice(0, 1) })).status).toBe(409);
    expect((await f.post('/api/public/drop-in', { ...input, waivers: input.waivers.map(w => ({ ...w, consent: false })) })).status).toBe(400);
    expect((await f.post('/api/public/drop-in', { ...input, waivers: input.waivers.map(w => ({ ...w, templateVersion: 99 })) })).status).toBe(409);
    expect((await f.rows()).members.filter(m => m.status === 'visitor')).toHaveLength(0);
    const guardian = { ...input, waivers: input.waivers.map(w => ({ ...w, signer: { kind: 'guardian', name: 'Alex Contact', relationship: 'Parent' } })) };
    expect((await f.post('/api/public/drop-in', guardian)).status).toBe(200);
  });
  it('rejects malformed PNGs before creating records and enforces image/body bounds', async () => {
    const f = await fixture(), invalid = f.admission(), before = (await f.rows()).members.length;
    invalid.signatures[0]!.pngBase64 = Buffer.from('not a PNG').toString('base64');
    expect((await f.post('/drop-in/signatures', invalid)).status).toBe(400);
    expect((await f.post('/drop-in/signatures', { ...f.admission(), signatures: f.admission().signatures.map(s => ({ ...s, pngBase64: 'a'.repeat(350_001) })) })).status).toBe(400);
    expect((await f.rows()).members).toHaveLength(before);
    expect((await f.post('/api/public/trial', { ...body(), padding: 'x'.repeat(2_900_000) })).status).toBe(400);
  });
  it('requires review after publication and leaves an admitted visitor as a prospect', async () => {
    const f = await fixture(), input = await f.admit();
    await f.waivers.publishTemplate({ gymId: f.gymId, actor: { kind: 'system' } }, f.template.id,
      { name: f.template.name, kind: 'waiver', expectedVersion: 1, body: 'Revised participation terms.' });
    expect((await f.post('/api/public/drop-in', input)).status).toBe(409);
    expect((await f.rows()).signatures).toHaveLength(0); expect((await f.rows()).members.filter(m => m.status === 'visitor')).toHaveLength(0);
  });
  it('uses the bounded demo signature path and cannot bypass its persistent lifetime budget', async () => {
    const f = await fixture(true), input = await f.admit();
    expect((await f.post('/api/public/drop-in', input)).status).toBe(200);
    await db.forGym(f.gymId, async tx => {
      for (let i = 0; i < 62; i++) await tx.insert(auditEvents).values({ id: uuidv7(), gymId: f.gymId, actorKind: 'system', action: demoSignatureReservation, targetType: 'member', targetId: f.existing.id, occurredAt: f.clock.now() });
    });
    const limited = await f.post('/drop-in/signatures', f.admission()); expect(limited.status).toBe(429);
    expect((await f.rows()).signatures).toHaveLength(2);
  });
  it('submits native trial and multipart drop-in forms without JavaScript', async () => {
    const f = await fixture(), input = body(), fields = { firstName: input.member.firstName, lastName: input.member.lastName, dateOfBirth: input.member.dateOfBirth, contactName: input.contact.name, email: input.contact.email, honeypot: '' };
    const trial = await f.server.request(origin + '/trial', { method: 'POST', headers: { origin }, body: new URLSearchParams(fields) });
    expect(trial.status).toBe(200); expect(await trial.text()).toContain('Request received');
    const form = new FormData(); for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const templates = await f.service.required(f.gymId);
    for (const [i, t] of templates.entries()) {
      form.set(`waiver-${i}-template`, t.id); form.set(`waiver-${i}-version`, String(t.version)); form.set(`waiver-${i}-kind`, 'self'); form.set(`waiver-${i}-name`, 'New Visitor'); form.set(`waiver-${i}-consent`, 'on');
      form.set(`waiver-${i}-image`, new File([new Uint8Array(png)], 'signature.png', { type: 'image/png' }));
    }
    const dropIn = await f.server.request(origin + '/drop-in', { method: 'POST', headers: { origin }, body: form });
    expect(dropIn.status).toBe(200); expect(await dropIn.text()).toContain('Request received');
    expect((await f.rows()).members.filter(m => m.status === 'visitor')).toHaveLength(1);
  });
  it.each(['/trial', '/drop-in'])('renders an HTML 400 for non-form, unparseable and invalid bodies on %s', async path => {
    const f = await fixture(), before = await f.rows();
    for (const [contentType, payload] of [['application/json', '{}'], ['text/plain', 'invalid'],
      ['multipart/form-data', 'no boundary'], ['application/x-www-form-urlencoded', 'firstName=Incomplete']]) {
      const response = await f.server.request(origin + path, { method: 'POST', headers: { origin, 'content-type': contentType! }, body: payload! });
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('text/html');
      const html = await response.text();
      expect(html).toContain('North &lt;Gym&gt;'); expect(html).toContain('href="/source"');
      expect(html).not.toContain('Request received');
    }
    expect((await f.rows()).members).toHaveLength(before.members.length); expect(f.notices).toHaveLength(0);
  });
  it('renders a useful contact state when no waivers or fee are configured', async () => {
    const f = await fixture();
    await db.forGym(f.otherGym, tx => tx.delete(waiverSignatures));
    // The other gym has no fee but still has a waiver.
    const html = await (await f.app(f.otherGym).request(origin + '/drop-in')).text(); expect(html).toContain('confirm the mat fee');
    await f.waivers.retireTemplate({ gymId: f.otherGym, actor: { kind: 'system' } }, f.foreignTemplate.id, { expectedVersion: 1 });
    const unavailable = await (await f.app(f.otherGym).request(origin + '/drop-in')).text();
    expect(unavailable).toContain('contact the gym to arrange'); expect(unavailable).not.toContain('data-public-form');
  });
  it('refuses foreign logo keys and active content instead of redirecting to arbitrary branding URLs', async () => {
    const f = await fixture();
    const settings = createSettingsService({ scope: db.forGym, clock: f.clock });
    await settings.update({ gymId: f.otherGym, actor: { kind: 'system' } }, 'general', { revision: 1, branding: { logoKey: f.gymId + '/logo.png' } });
    expect((await f.app(f.otherGym).request(origin + '/public/pages/logo/' + logoVersion(f.gymId + '/logo.png'))).status).toBe(404);
    await f.uploads.get(f.gymId)!.put(f.gymId + '/logo.svg', new TextEncoder().encode('<svg/>'), 'image/svg+xml');
    await settings.update({ gymId: f.gymId, actor: { kind: 'system' } }, 'general', { revision: 1, branding: { logoKey: f.gymId + '/logo.svg' } });
    expect((await f.server.request(origin + '/public/pages/logo/' + logoVersion(f.gymId + '/logo.svg'))).status).toBe(404);
  });
  it('rejects cross-origin mutations through the production CSRF guard', async () => {
    const f = await fixture();
    const response = await f.server.request(origin + '/api/public/trial', { method: 'POST', headers: { origin: 'https://attacker.invalid', cookie: 'session=untrusted', 'content-type': 'application/json' }, body: JSON.stringify(body()) });
    expect(response.status).toBe(403); expect(f.notices).toHaveLength(0);
  });
});
