// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import '@hono/zod-openapi';
import { auditEvents, members, households, waiverSignatures, invoices, uuidv7 } from '@plaingym/db';
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
import { readSnapshot } from '../../areas/waivers/snapshot.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { FakeEmail } from '../../infra/email/index.js';
import { demoUploads } from '../../demo/uploads.js';
import { demoSignatureReservation } from '../../demo/waiver-signatures.js';
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';
import { configurePublicPages, createPublicRoutes } from './pages.routes.js';
import { createPublicStaffNotifier } from './notifications.js';
import { themeCss } from './page.js';

const db = useTestDatabase(), factory = createFactories(db), png = demoSignaturePng();
const origin = 'https://gym.example.test';
const body = (email = 'visitor@example.invalid') => ({ contact: { name: 'Alex Contact', email },
  member: { firstName: 'New', lastName: 'Visitor', dateOfBirth: '1990-01-02' }, honeypot: '' });
async function fixture(demo = false) {
  const gymId = uuidv7(), otherGym = uuidv7(), clock = new TestClock('2026-10-29T12:00:00Z');
  await factory('gyms', gymId, { name: 'North <Gym>', websiteEnabled: false, branding: { primaryColor: '#ffff00', logoKey: gymId + '/logo.png' } });
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
  const waivers = createWaiversService({ scope: db.forGym, clock, uploadsFor });
  const mail = new FakeEmail();
  const service = configurePublicPages({ scope: db.forGym, clock, waivers, uploadsFor,
    settings: createSettingsService({ scope: db.forGym, clock }), stylesheet: async () => '/* shared css */',
    dropInFeeFor: async id => id === gymId ? { amountCents: 2500, currency: 'CAD' } : null,
    notifyStaff: createPublicStaffNotifier(async () => ({ email: mail, recipients: ['staff@example.invalid'], gymName: 'North Gym' })) });
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
    signatures: await tx.select().from(waiverSignatures), audits: await tx.select().from(auditEvents), invoices: await tx.select().from(invoices) }));
  return { gymId, otherGym, clock, existing, existingHome, sibling, template, secondTemplate, foreignTemplate, waivers, uploads, mail, service, app, server, post, admission, admit, rows };
}

describe('core public pages through the production registrations', () => {
  it('renders branded pages with the website off, escaped terms, CSP, fee and source link', async () => {
    const f = await fixture();
    for (const path of ['/trial', '/drop-in', '/trial/received', '/drop-in/received']) {
      const response = await f.server.request(origin + path), html = await response.text();
      expect(response.status).toBe(200); expect(html).toContain('North &lt;Gym&gt;');
      expect(html).toContain('href="/source"'); expect(html).not.toContain('Private Member');
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(response.headers.get('cache-control')).toBe('no-store');
      if (path === '/drop-in') { expect(html).toContain('$25.00'); expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;'); expect(html).not.toContain('<script>bad()'); }
    }
    const theme = await f.server.request(origin + '/public/pages/theme.css');
    expect(await theme.text()).toContain('--color-primary:#ffff00;--color-primary-foreground:#000000');
    expect((await f.server.request(origin + '/public/pages/client.js')).headers.get('content-type')).toContain('text/javascript');
    expect(await (await f.server.request(origin + '/public/pages/styles.css')).text()).toContain('shared css');
  });
  it('projects only the resolved gym config, templates, color and logo, across every read route', async () => {
    const f = await fixture(), other = f.app(f.otherGym);
    for (const path of ['/trial', '/drop-in', '/trial/received', '/drop-in/received', '/api/public/config', '/api/public/waivers', '/public/pages/theme.css']) {
      const response = await other.request(origin + path), text = await response.text();
      expect(response.status).toBe(200); expect(text).not.toContain('North'); expect(text).not.toContain(f.template.id); expect(text).not.toContain('#ffff00');
    }
    expect((await other.request(origin + '/public/pages/logo/1')).status).toBe(404);
    expect((await f.server.request(origin + '/public/pages/logo/1')).headers.get('content-type')).toBe('image/png');
    expect((await f.server.request(origin + '/public/pages/logo/2')).status).toBe(404);
    expect(await (await f.server.request(origin + '/trial')).text()).toContain('src="/public/pages/logo/1"');
    const config = await (await f.server.request(origin + '/api/public/config')).json();
    expect(publicContracts.config.response.parse(config).data.dropInFee).toEqual({ amountCents: 2500, currency: 'CAD' });
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
    expect(f.mail.messages).toHaveLength(2); expect(f.mail.messages.every(m => m.to === 'staff@example.invalid')).toBe(true);
    expect(rows.audits.filter(a => a.action === 'public.trial.received')).toHaveLength(2);
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
    expect((await f.rows()).members).toHaveLength(before.members.length); expect(f.mail.messages).toHaveLength(0);
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
  it('signs all immutable waivers, creates a visitor without a payment, and replays without duplicates', async () => {
    const f = await fixture(), input = await f.admit();
    expect((await f.rows()).members.find(m => m.id === input.waivers[0]!.signatureImageKey.split('/')[2])!.status).toBe('prospect');
    const response = await f.post('/api/public/drop-in', input); expect(response.status).toBe(200);
    expect(publicSubmissionResponseSchema.parse(await response.json())).toEqual({ data: { status: 'received' } });
    expect((await f.post('/api/public/drop-in', input)).status).toBe(200);
    const rows = await f.rows(); expect(rows.members.filter(m => m.status === 'visitor')).toHaveLength(1); expect(rows.signatures).toHaveLength(2); expect(rows.invoices).toHaveLength(0);
    expect(readSnapshot(rows.signatures[0]!.snapshot, rows.signatures[0]!.snapshotHash).member.firstName).toBe('New');
    expect(f.mail.messages).toHaveLength(1); expect(rows.audits.filter(a => a.action === 'public.drop_in.received')).toHaveLength(1);
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
    expect((await f.rows()).members).toHaveLength(before.members.length); expect(f.mail.messages).toHaveLength(0);
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
    expect((await f.app(f.otherGym).request(origin + '/public/pages/logo/2')).status).toBe(404);
    await f.uploads.get(f.gymId)!.put(f.gymId + '/logo.svg', new TextEncoder().encode('<svg/>'), 'image/svg+xml');
    await settings.update({ gymId: f.gymId, actor: { kind: 'system' } }, 'general', { revision: 1, branding: { logoKey: f.gymId + '/logo.svg' } });
    expect((await f.server.request(origin + '/public/pages/logo/2')).status).toBe(404);
  });
  it('rejects cross-origin mutations through the production CSRF guard', async () => {
    const f = await fixture();
    const response = await f.server.request(origin + '/api/public/trial', { method: 'POST', headers: { origin: 'https://attacker.invalid', cookie: 'session=untrusted', 'content-type': 'application/json' }, body: JSON.stringify(body()) });
    expect(response.status).toBe(403); expect(f.mail.messages).toHaveLength(0);
  });
});

it('validates CSS colors and chooses a contrasting foreground', () => {
  expect(themeCss('#ffffff')).toContain('#000000'); expect(themeCss('#000000')).toContain('#ffffff');
  expect(themeCss('red; background:url(https://evil.invalid)')).toBe(''); expect(themeCss(null)).toBe('');
});
