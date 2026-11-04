// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '@hono/zod-openapi';
import { auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { createApp } from '../../app.js';
import { areaContributions } from '../../core/registry-areas.js';
import { enabledModules } from '../../core/modules.js';
import { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import { authorize } from '../../areas/staff/auth.permissions.js';
import { createSettingsService } from '../../areas/settings/settings.js';
import { createModuleSettings } from '../../areas/settings/module-settings.js';
import { configurePublicPages } from '../../public/pages/pages.routes.js';
import { createWaiversService } from '../../areas/waivers/waivers.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { websiteModule } from './index.js';
import { createWebsiteRoutes } from './routes.js';
import { createWebsiteService } from './service.js';
import { sitePages, pagePath } from './site.page.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-11-03T12:00:00Z');
const origin = 'https://north.example.test', gymA = uuidv7(), gymB = uuidv7();
const uploads = new Map([gymA, gymB].map((id) => [id, new FakeUploads(id, clock)]));
const uploadsFor = async (id: string) => uploads.get(id)!;
const settings = createSettingsService({ scope: db.forGym, clock });
const service = createWebsiteService({ scope: db.forGym, clock, uploadsFor });
const users = new Map<StaffRole, string>();
const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
const owner = (gymId = gymA): Principal => ({ kind: 'staff', gymId, userId: users.get('owner')!, roles: ['owner'] });
let publicDirectory = '';
const ids: Record<string, string> = {};

beforeAll(async () => {
  await factory('gyms', gymA, { name: 'North <Gym>', timezone: 'America/Vancouver', websiteEnabled: true,
    address: { line1: '12 Mat Street', city: 'Vancouver', region: 'BC', postalCode: 'V5K 0A1', country: 'CA' } });
  await factory('gyms', gymB, { name: 'Private Other Gym', websiteEnabled: true, address: { line1: '99 Hidden Road' } });
  for (const role of staffRoles) users.set(role, (await factory('staffRoles', gymA, { role })).userId);
  const coach = await factory('staffProfiles', gymA, { displayName: 'Coach Public', bio: 'Teaches <fundamentals>.', rank: 'Senior coach', isPublic: true, photoKey: `${gymA}/staff/coach.jpg` });
  const hidden = await factory('staffProfiles', gymA, { displayName: 'Coach Hidden', isPublic: false, photoKey: `${gymA}/staff/hidden.jpg` });
  await uploads.get(gymA)!.put(`${gymA}/staff/coach.jpg`, jpeg, 'image/jpeg');
  await uploads.get(gymA)!.put(`${gymA}/staff/hidden.jpg`, jpeg, 'image/jpeg');
  const fundamentals = await factory('programs', gymA, { name: 'Fundamentals' });
  await factory('programs', gymA, { name: 'Retired program', active: false });
  const monday = await factory('classTemplates', gymA, { name: 'Morning basics', weekday: 1, localStartTime: '06:30', durationMinutes: 60, coachId: coach.id });
  await factory('classTemplatePrograms', gymA, { templateId: monday.id, programId: fundamentals.id });
  await factory('classTemplates', gymA, { name: 'Sunday open mat', weekday: 0, localStartTime: '10:00', durationMinutes: 90, kind: 'open_mat', coachId: hidden.id });
  const taxed = await factory('plans', gymA, { name: 'Unlimited', amountCents: 12_000, interval: 'monthly', signupFeeCents: 5000 });
  const tax = await factory('taxRates', gymA, { name: 'Sales tax', rateMillionths: 50_000 });
  await factory('planTaxRates', gymA, { planId: taxed.id, taxRateId: tax.id });
  await factory('plans', gymA, { name: 'Yearly', amountCents: 99_000, interval: 'annual', trialDays: 7 });
  await factory('plans', gymA, { name: 'Archived plan', amountCents: 1000, active: false });
  const otherCoach = await factory('staffProfiles', gymB, { displayName: 'Other Gym Coach', isPublic: true, photoKey: `${gymB}/staff/other.jpg` });
  await uploads.get(gymB)!.put(`${gymB}/staff/other.jpg`, jpeg, 'image/jpeg');
  await factory('programs', gymB, { name: 'Other Gym Program' });
  await factory('classTemplates', gymB, { name: 'Other Gym Class' });
  await factory('plans', gymB, { name: 'Other Gym Plan' });
  Object.assign(ids, { coach: coach.id, hidden: hidden.id, otherCoach: otherCoach.id });
  publicDirectory = await mkdtemp(join(tmpdir(), 'plaingym-website-'));
  await writeFile(join(publicDirectory, 'index.html'), '<!doctype html><title>Portal app</title>');
  configurePublicPages({ scope: db.forGym, clock, uploadsFor, stylesheet: async () => '/* css */', notifyStaff: async () => {},
    waivers: createWaiversService({ scope: db.forGym, clock, uploadsFor }) });
  return () => rm(publicDirectory, { recursive: true, force: true });
});

/** The real composition: area routes plus the module, with each request's modules read from the gym, as the tenant resolver does. */
function app(gymId = gymA, principal: Principal = { kind: 'anonymous' }, permissions = authorize) {
  const website = { ...websiteModule, routes: createWebsiteRoutes({ service, origin: () => origin }) };
  return createApp({ skipSetup: true, clock, authorize: permissions, publicDirectory, contributions: { ...areaContributions, modules: [website] }, origin,
    rateLimit: { limit: 10_000 },
    resolveGym: async (ctx, next) => {
      const gym = await settings.get(gymId);
      ctx.set('context', { ...ctx.get('context'), gym: { gymId, timezone: gym.timezone, enabledModules: enabledModules(gym) } }); await next();
    },
    session: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), principal }); await next(); } });
}
const get = (path: string, target = app()) => target.request(origin + path, { headers: { accept: 'text/html' } });
const send = (method: string, path: string, body: unknown, target = app(gymA, owner())) =>
  target.request(origin + path, { method, headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const revision = async (gymId = gymA) => (await settings.get(gymId)).revision;
/** The fields a save sends back: a settings response without its read-only `logo` flag. */
const editable = ({ logo: _logo, ...rest }: Awaited<ReturnType<typeof service.settings>>) => rest;
async function toggle(gymId: string, on: boolean) {
  await settings.update({ gymId, actor: { kind: 'system' } }, 'general', { websiteEnabled: on, revision: await revision(gymId) });
}
const websitePaths = [...sitePages.map(pagePath), '/sitemap.xml', '/robots.txt', '/website/theme.css', '/api/website'];

describe('the module toggle', () => {
  it('removes every website route when off, sends / to the portal, and leaves the core pages and the portal alone', async () => {
    const photo = await service.uploadPhoto({ gymId: gymA, actor: { kind: 'system' } }, { revision: await revision(), contentType: 'image/jpeg', base64: jpeg.toString('base64'), alt: 'Mats' });
    await toggle(gymA, false);
    try {
      const off = app(gymA, owner());
      const root = await get('/', off);
      expect(root.status).toBe(302); expect(root.headers.get('location')).toBe('/portal');
      for (const path of [...websitePaths.filter((path) => path !== '/'), `/website/photos/${photo.photos[0]!.id}`, `/website/coaches/${ids.coach}/photo`])
        expect((await get(path, off)).status, path).toBe(404);
      for (const [method, path] of [['PUT', '/api/website'], ['POST', '/api/website/photos'], ['POST', '/api/website/logo'], ['DELETE', '/api/website/logo']] as const)
        expect((await send(method, path, {}, off)).status, path).toBe(404);
      for (const path of ['/trial', '/drop-in']) expect((await get(path, off)).status, path).toBe(200);
      const portal = await get('/portal', off);
      expect(portal.status).toBe(200); expect(await portal.text()).toContain('Portal app');
    } finally { await toggle(gymA, true); }
    const on = app(gymA, owner());
    expect((await get('/', on)).status).toBe(200);
    for (const path of websitePaths) expect((await get(path, on)).status, path).toBe(200);
    for (const path of ['/trial', '/drop-in', '/portal']) expect((await get(path, on)).status, path).toBe(200);
    await service.update({ gymId: gymA, actor: { kind: 'system' } }, { ...editable(await service.settings(gymA)), photos: [] });
  });

  it('checks the toggle on every request: one gym on and another off at the same time', async () => {
    await toggle(gymB, false);
    try {
      expect((await get('/', app(gymB))).status).toBe(302);
      expect((await get('/programs', app(gymB))).status).toBe(404);
      expect((await get('/programs', app(gymA))).status).toBe(200);
    } finally { await toggle(gymB, true); }
  });
});

describe('the pages', () => {
  beforeAll(async () => {
    await service.update({ gymId: gymA, actor: { kind: 'system' } }, { revision: await revision(), tagline: 'Train with <friends>', about: 'Open since 2010.\nAll levels welcome.',
      phone: '+1 (604) 555-0100', email: 'hello@north.example.test', accentColor: '#112233', primaryColor: '#ffcc00', photos: [] });
    await service.uploadPhoto({ gymId: gymA, actor: { kind: 'system' } }, { revision: await revision(), contentType: 'image/jpeg', base64: jpeg.toString('base64'), alt: 'The mats' });
  });
  const html = async (path: string, target = app()) => {
    const response = await get(path, target);
    expect(response.status, path).toBe(200);
    return { body: await response.text(), headers: response.headers };
  };

  it('render every page under a nonce policy with no inline script, handler or style', async () => {
    for (const path of sitePages.map(pagePath)) {
      const { body, headers } = await html(path);
      const policy = headers.get('content-security-policy')!;
      expect(policy, path).toMatch(/default-src 'none'/);
      expect(policy, path).not.toContain('unsafe-inline');
      expect(policy, path).toContain("frame-ancestors 'none'");
      const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
      expect(nonce, path).toBeTruthy();
      for (const [, attributes] of body.matchAll(/<script([^>]*)>/g)) {
        expect(attributes, path).toContain(`nonce="${nonce}"`);
        expect(attributes, path).toContain('type="application/ld+json"');
      }
      expect(body, path).not.toMatch(/\son[a-z]+=/i);
      expect(body, path).not.toMatch(/\sstyle=/i);
      expect(body, path).toContain('href="/source"');
      expect(body, path).toContain('href="/portal"');
      expect(body, path).toContain('name="viewport"');
      expect(body, path).toContain(`<link rel="canonical" href="${origin}${path}"/>`);
      expect(body, path).not.toContain('noindex');
      expect(body, path).toContain('North &lt;Gym&gt;');
      expect(body, path).not.toContain('North <Gym>');
      expect(headers.get('x-frame-options'), path).toBe('DENY');
    }
    // A fresh nonce for each response.
    const [first, second] = await Promise.all([get('/'), get('/')]);
    expect(first.headers.get('content-security-policy')).not.toBe(second.headers.get('content-security-policy'));
  });

  it('show the home page with its call to action, about text, photos, programs and structured data', async () => {
    const { body } = await html('/');
    for (const href of ['/trial', '/join', '/portal', '/drop-in', '/programs', '/schedule', '/plans', '/coaches', '/contact']) expect(body).toContain(`href="${href}"`);
    expect(body).toContain('Train with &lt;friends&gt;');
    expect(body).toContain('Open since 2010.\nAll levels welcome.');
    expect(body).toContain('Fundamentals'); expect(body).not.toContain('Retired program');
    expect(body).toMatch(/<img src="\/website\/photos\/[0-9a-f-]+" alt="The mats"/);
    expect(body).toContain('<meta name="description" content="Train with &lt;friends&gt;"/>');
    const data = JSON.parse(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/s.exec(body)![1]!);
    expect(data).toMatchObject({ '@context': 'https://schema.org', '@type': 'LocalBusiness', name: 'North <Gym>', url: origin + '/',
      telephone: '+1 (604) 555-0100', email: 'hello@north.example.test', description: 'Train with <friends>',
      address: { '@type': 'PostalAddress', streetAddress: '12 Mat Street', addressLocality: 'Vancouver', addressRegion: 'BC', postalCode: 'V5K 0A1', addressCountry: 'CA' } });
    expect(data.image[0]).toMatch(new RegExp('^' + origin + '/website/photos/'));
    // The data block can't be closed early by gym text.
    expect(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/s.exec(body)![1]).not.toContain('<');
  });

  it('list programs with their classes, and the weekly schedule Monday first with only public coaches named', async () => {
    const programs = (await html('/programs')).body;
    expect(programs).toContain('Fundamentals'); expect(programs).toContain('Monday, 6:30 AM–7:30 AM');
    expect(programs).not.toContain('Retired program');
    const schedule = (await html('/schedule')).body;
    expect(schedule.indexOf('Monday')).toBeLessThan(schedule.indexOf('Sunday'));
    expect(schedule).toContain('10:00 AM–11:30 AM'); expect(schedule).toContain('Open mat');
    expect(schedule).toContain('With Coach Public'); expect(schedule).not.toContain('Coach Hidden');
    expect(schedule).toContain('America/Vancouver');
  });

  it('list active plans in the gym currency with tax, fees and trials, and public coaches only', async () => {
    const plans = (await html('/plans')).body;
    expect(plans).toContain('$120.00 per month + tax'); expect(plans).toContain('Sign-up fee: $50.00');
    expect(plans).toContain('$990.00 per year'); expect(plans).toContain('Free trial days: 7');
    expect(plans).not.toContain('Archived plan');
    const coaches = (await html('/coaches')).body;
    expect(coaches).toContain('Coach Public'); expect(coaches).toContain('Teaches &lt;fundamentals&gt;.'); expect(coaches).toContain('Senior coach');
    expect(coaches).toContain(`/website/coaches/${ids.coach}/photo`); expect(coaches).not.toContain('Coach Hidden');
  });

  it('give the location and contact details with tel, mailto and map links', async () => {
    const { body } = await html('/contact');
    expect(body).toContain('href="tel:+16045550100"'); expect(body).toContain('href="mailto:hello@north.example.test"');
    expect(body).toContain('https://www.openstreetmap.org/search?query=12%20Mat%20Street');
    expect(body).toContain('application/ld+json');
  });

  it('publish a sitemap, robots rules and a validated theme', async () => {
    const sitemap = await get('/sitemap.xml');
    expect(sitemap.headers.get('content-type')).toContain('application/xml');
    const xml = await sitemap.text();
    for (const path of sitePages.map(pagePath)) expect(xml).toContain(`<loc>${origin}${path}</loc>`);
    expect(xml).not.toContain('/trial');
    const robots = await (await get('/robots.txt')).text();
    expect(robots).toContain(`Sitemap: ${origin}/sitemap.xml`); expect(robots).toContain('Disallow: /admin');
    const theme = await (await get('/website/theme.css')).text();
    expect(theme).toBe(':root{--color-primary:#ffcc00;--color-primary-foreground:#000000;--color-secondary:#112233;--color-secondary-foreground:#ffffff}');
  });

  it('serve photos, and a coach photo only while the profile is public', async () => {
    const photo = (await service.settings(gymA)).photos[0]!;
    const response = await get('/website/photos/' + photo.id);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(jpeg);
    expect((await get(`/website/coaches/${ids.coach}/photo`)).status).toBe(200);
    expect((await get(`/website/coaches/${ids.hidden}/photo`)).status).toBe(404);
    expect((await get(`/website/photos/${uuidv7()}`)).status).toBe(404);
    expect((await get('/website/photos/not-an-id')).status).toBe(400);
  });

  it('never show another gym: its data, photos and coaches stay on its own host', async () => {
    for (const path of sitePages.map(pagePath)) {
      const { body } = await html(path);
      for (const foreign of ['Private Other Gym', '99 Hidden Road', 'Other Gym Coach', 'Other Gym Program', 'Other Gym Class', 'Other Gym Plan'])
        expect(body, path).not.toContain(foreign);
    }
    const photo = (await service.settings(gymA)).photos[0]!;
    expect((await get('/website/photos/' + photo.id, app(gymB))).status).toBe(404);
    expect((await get(`/website/coaches/${ids.otherCoach}/photo`, app(gymA))).status).toBe(404);
    expect((await get(`/website/coaches/${ids.coach}/photo`, app(gymB))).status).toBe(404);
    const other = (await html('/', app(gymB))).body;
    expect(other).toContain('Private Other Gym'); expect(other).not.toContain('North &lt;Gym&gt;'); expect(other).not.toContain('The mats');
  });
});

describe('the customization API', () => {
  it('lets only owners and admins read and change the website', async () => {
    for (const role of staffRoles) {
      const principal: Principal = { kind: 'staff', gymId: gymA, userId: users.get(role)!, roles: [role] };
      const allowed = ['owner', 'admin'].includes(role);
      expect((await get('/api/website', app(gymA, principal))).status, role).toBe(allowed ? 200 : 403);
      expect((await send('PUT', '/api/website', { revision: 1 }, app(gymA, principal))).status, role).toBe(allowed ? 400 : 403);
    }
    expect((await get('/api/website')).status).toBe(401);
    expect((await send('POST', '/api/website/photos', {}, app())).status).toBe(401);
  });

  it('refuses a staff session of one gym on another gym host, and never changes that gym', async () => {
    const before = await service.settings(gymB);
    const requests = [['GET', '/api/website', undefined], ['PUT', '/api/website', { ...editable(before), tagline: 'Taken over' }],
      ['POST', '/api/website/photos', { revision: before.revision, contentType: 'image/jpeg', base64: jpeg.toString('base64'), alt: '' }],
      ['POST', '/api/website/logo', { revision: before.revision, contentType: 'image/jpeg', base64: jpeg.toString('base64') }],
      ['DELETE', '/api/website/logo', { revision: before.revision }]] as const;
    // The permission check denies it; behind that, each handler answers 404 for a session bound to another gym.
    const allowAll: typeof authorize = () => async (_c, next) => { await next(); };
    for (const [method, path, body] of requests) {
      expect((await send(method, path, body, app(gymB, owner(gymA)))).status, path).toBe(403);
      expect((await send(method, path, body, app(gymB, owner(gymA), allowAll))).status, path).toBe(404);
    }
    expect(await service.settings(gymB)).toEqual(before);
    expect(await uploads.get(gymB)!.list(`${gymB}/website/`)).toHaveLength(0);
  });

  it('saves text and colors under the gym revision, audits the change, and refuses a stale save', async () => {
    type Settings = Awaited<ReturnType<typeof service.settings>>;
    const current = (await (await get('/api/website', app(gymA, owner()))).json() as { data: Settings }).data;
    const saved = await send('PUT', '/api/website', { revision: current.revision, tagline: '  Strong together  ', about: '', phone: null, email: null,
      accentColor: null, primaryColor: '#0055aa', photos: current.photos });
    expect(saved.status).toBe(200);
    const data = editable((await saved.json() as { data: Settings }).data);
    expect(data).toMatchObject({ revision: current.revision + 1, tagline: 'Strong together', about: null, primaryColor: '#0055aa' });
    expect((await settings.get(gymA)).branding.primaryColor).toBe('#0055aa');
    const audits = await db.forGym(gymA, (tx) => tx.select().from(auditEvents));
    expect(audits.some((row) => row.action === 'settings.module.updated' && (row.after as { module: string }).module === 'website')).toBe(true);
    expect((await send('PUT', '/api/website', { ...data, revision: current.revision, tagline: 'Stale' })).status).toBe(409);
    expect((await send('PUT', '/api/website', { ...data, primaryColor: 'red' })).status).toBe(400);
    expect((await send('PUT', '/api/website', { ...data, photos: [{ id: uuidv7(), alt: 'Not uploaded' }] })).status).toBe(404);
  });

  it('adds, reorders, describes and removes photos, releasing removed files after the save', async () => {
    const upload = async (bytes: Buffer, contentType: string, alt = 'Photo') => send('POST', '/api/website/photos',
      { revision: await revision(), contentType, base64: bytes.toString('base64'), alt });
    const start = (await service.settings(gymA)).photos.length;
    expect((await upload(png, 'image/png', 'Second')).status).toBe(200);
    expect((await upload(Buffer.from('not an image'), 'image/png')).status).toBe(400);
    expect((await upload(jpeg, 'image/png')).status).toBe(400);
    expect((await upload(Buffer.alloc(600 * 1024, 1), 'image/png')).status).toBe(400);
    const photos = (await service.settings(gymA)).photos;
    expect(photos).toHaveLength(start + 1);
    const [first, second] = [photos[0]!, photos[1]!];
    const keys = ((await createModuleSettings({ scope: db.forGym }).get(gymA, 'website')).value as { photos: { id: string; key: string }[] }).photos;
    expect(keys.every((photo) => photo.key.startsWith(`${gymA}/website/photos/`))).toBe(true);
    const current = editable(await service.settings(gymA));
    const reordered = await send('PUT', '/api/website', { ...current, photos: [{ id: second.id, alt: 'Now first' }] });
    expect(reordered.status).toBe(200);
    expect((await service.settings(gymA)).photos).toEqual([{ id: second.id, alt: 'Now first' }]);
    const removed = keys.find((photo) => photo.id === first.id)!.key;
    expect((await uploads.get(gymA)!.head(removed))?.deletedAt).toBeTruthy();
    expect((await get('/website/photos/' + first.id)).status).toBe(404);
    // At most eight photos.
    for (let i = (await service.settings(gymA)).photos.length; i < 8; i++) expect((await upload(jpeg, 'image/jpeg')).status).toBe(200);
    expect((await upload(jpeg, 'image/jpeg')).status).toBe(409);
    expect((await service.settings(gymA)).photos).toHaveLength(8);
  });

  it('uploads and removes the logo, which the core public pages show too', async () => {
    const uploaded = await send('POST', '/api/website/logo', { revision: await revision(), contentType: 'image/png', base64: png.toString('base64') });
    expect(uploaded.status).toBe(200);
    const first = (await settings.get(gymA)).branding.logoKey!;
    expect(first.startsWith(`${gymA}/website/logo/`)).toBe(true);
    expect((await get('/public/pages/logo/' + await revision())).status).toBe(200);
    expect(await (await get('/')).text()).toContain(`/public/pages/logo/${await revision()}`);
    expect((await send('POST', '/api/website/logo', { revision: await revision(), contentType: 'image/jpeg', base64: jpeg.toString('base64') })).status).toBe(200);
    expect((await uploads.get(gymA)!.head(first))?.deletedAt).toBeTruthy();
    const second = (await settings.get(gymA)).branding.logoKey!;
    const removed = await send('DELETE', '/api/website/logo', { revision: await revision() });
    expect(removed.status).toBe(200);
    expect((await removed.json() as { data: { logo: boolean } }).data.logo).toBe(false);
    expect((await settings.get(gymA)).branding.logoKey).toBeNull();
    expect((await uploads.get(gymA)!.head(second))?.deletedAt).toBeTruthy();
    // A stale upload stores nothing.
    const files = (await uploads.get(gymA)!.list(`${gymA}/website/logo/`)).length;
    expect((await send('POST', '/api/website/logo', { revision: 1, contentType: 'image/png', base64: png.toString('base64') })).status).toBe(409);
    expect((await uploads.get(gymA)!.list(`${gymA}/website/logo/`)).length).toBe(files);
  });
});
