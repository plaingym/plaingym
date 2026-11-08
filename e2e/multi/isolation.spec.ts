// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { test, expect, Client, missingId, type Document } from '../support.js';
import { claimPortal, signaturePng } from '../portal.js';
import { mailIds, mailLink, multiGyms, withCookie, type Context } from './support.js';
import { bodiesOf, hasJsonBody, namesTarget, outOfScope, pathFor, pathParams, queryOf, routeKey, routesOf, snapshot, targetOf,
  type Aim, type Route, type Target } from './probe.js';

interface Entry { method: string; path: string; permission: { kind: string } }
const inventory: Entry[] = JSON.parse(await readFile(new URL('../authorization-inventory.json', import.meta.url), 'utf8'));

// Signed-link tokens, session cookies and device tokens are bearer credentials. Keep them out of traces.
test.use({ trace: 'off', screenshot: 'off' });

const unreached = [400, 401, 403, 404, 405, 413, 415, 422, 429];
/** Kiosk check-ins answer a shared screen: a member the device can't check in is sent to the front desk, with status 200. */
const refusedWith200: Record<string, unknown> = {
  'POST /api/kiosk/checkin': { data: [{ status: 'see_front_desk' }] },
  'POST /api/kiosk/checkin/qr': { data: { status: 'see_front_desk' } },
};
interface SignatureImage { signatureImageKey: string; signatureImageHash: string }
type Images = Record<'link' | 'household' | 'staff' | 'onboarding', SignatureImage>;

/** One run's view of a pair of gyms: the credentials of the caller, and what it aims at. */
class Sweep {
  readonly links: Record<string, Client> = {};
  private self!: Client;
  images!: Images;
  private pngBase64 = '';
  private readonly revisions = new Map<string, number>();
  constructor(readonly from: Context, readonly to: Context, readonly own: Target, readonly target: Target, readonly document: Document) {}

  async prepare() {
    const { from } = this, expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    // The household payer has no member identity. Give the self-service document
    // route an adult member login, so both its positive and foreign-gym probes reach the template.
    const email = `document-reader@${from.slug}.example.invalid`;
    const member = (await from.owner.json<{ data: { id: string } }>('/api/members', 'POST', {
      householdId: from.householdId, firstName: 'Document', lastName: 'Reader', dateOfBirth: '1990-01-01', email,
    })).data;
    const invitation = (await from.owner.json<{ data: { invitationUrl: string } }>(`/api/households/${from.householdId}/portal-invitations`, 'POST',
      { email, scope: 'member', memberId: member.id, delivery: 'print' })).data;
    const before = await mailIds();
    await new Client(from.origin).json('/api/portal/invitations/accept', 'POST', { token: new URL(invitation.invitationUrl).hash.slice(1) });
    this.self = await claimPortal(from.origin, await mailLink(email, /^\/api\/auth\//, before));
    this.self.headers['X-Portal-Household'] = from.householdId;
    for (const [purpose, extra] of [['onboarding', {}], ['update_card', {}], ['sign_waiver', { memberId: from.student.id }], ['pay_invoice', { invoiceId: from.invoiceId }]] as const) {
      const created = await from.owner.json<{ data: { token: string } }>('/api/links', 'POST', { purpose, householdId: from.householdId, expiresAt, ...extra });
      this.links[purpose] = new Client(from.origin, { authorization: 'Bearer ' + created.data.token });
    }
    // Real signature images of the caller's own, so a waiver signed for the target's member or template fails on the gym boundary.
    const pngBase64 = this.pngBase64 = signaturePng().toString('base64'), image = async (client: Client, path: string, body: Record<string, unknown>) =>
      (await client.json<{ data: SignatureImage }>(path, 'POST', body)).data;
    this.images = {
      link: await image(this.links.sign_waiver!, '/api/links/sign-waiver/signature-images', { pngBase64 }),
      onboarding: await image(this.links.onboarding!, '/api/links/onboarding/signature-images', { memberId: from.student.id, pngBase64 }),
      household: await image(from.household, '/api/portal/household/waivers/signature-images', { memberId: from.student.id, pngBase64 }),
      staff: await image(from.owner, '/api/waivers/signature-images', { memberId: from.student.id, pngBase64 }),
    };
    // The parameterized document read must reach an actual document with its own link;
    // the sweep below aims that same credential at the other gym's template.
    expect((await this.links.sign_waiver!.request(`/api/links/sign-waiver/templates/${from.templateId}/document`)).status).toBe(200);
  }

  credentials(route: Route, origin: string): Client | undefined {
    const { from } = this;
    if (route.kind === 'staff') return withCookie(origin, from.cookies.owner);
    if (route.kind === 'member') return withCookie(origin,
      route.path === '/api/portal/waiver-templates/{templateId}/document' ? this.self.cookie : from.cookies.household,
      { 'X-Portal-Household': from.householdId });
    if (route.kind === 'kiosk') return new Client(origin, { authorization: 'Bearer ' + from.kioskToken });
    if (route.kind === 'signed_link') { const link = this.links[route.purpose ?? '']; return link && new Client(origin, link.headers); }
    return undefined;
  }

  /** The revision a body must carry to edit the record at the route's path, read by the gym that owns it. */
  async revisionOf(route: Route, owner: Context, pathTarget: Target) {
    const path = pathFor(route, pathTarget);
    if (!this.document.paths[route.path]?.get || route.kind === 'signed_link') return 1;
    if (!this.revisions.has(path)) {
      const response = await (route.kind === 'member' ? withCookie(owner.origin, owner.cookies.household) : owner.owner).request<{ data?: { revision?: number } }>(path);
      this.revisions.set(path, response.body?.data?.revision ?? 1);
    }
    return this.revisions.get(path)!;
  }

  /** Bodies naming the caller's own gym where the route's own purpose needs it (a name and PIN, a check-in code, signed waivers). */
  overrides(route: Route): unknown[] | undefined {
    const { from, target, images } = this, { ids } = target;
    const signer = { kind: 'guardian', name: 'Cross gym', relationship: 'Parent' };
    const signed = (image: SignatureImage) => ({ memberId: ids.memberId, templateId: ids.templateId, templateVersion: 1, signer, ...image, consent: true });
    const table: Record<string, unknown> = {
      // The caller's own name and PIN, or the target's check-in code, with the target's member: see `refusedWith200`.
      'POST /api/kiosk/checkin': { name: from.student.fullName, pin: from.pin, checkins: [{ memberId: ids.memberId, sessionId: null }] },
      'POST /api/kiosk/checkin/qr': { code: target.checkinCode, sessionId: null },
      'POST /api/links/sign-waiver': (({ memberId: _member, ...rest }) => rest)(signed(images.link)),
      'POST /api/links/onboarding/waivers': signed(images.onboarding),
      'POST /api/portal/waivers': signed(images.household),
      'POST /api/portal/household/waivers': signed(images.household),
      'POST /api/waivers/signatures': signed(images.staff),
      // OpenAPI cannot express the text/PDF refinement: the default empty body is not a valid version.
      'POST /api/waivers/templates/{templateId}/versions': { name: this.to.name + ' liability waiver', kind: 'waiver',
        body: 'Cross-gym terms', expectedVersion: 1 },
      'POST /api/links/onboarding/signature-images': { memberId: ids.memberId, pngBase64: this.pngBase64 },
      'POST /api/portal/household/waivers/signature-images': { memberId: ids.memberId, pngBase64: this.pngBase64 },
      'POST /api/portal/waivers/signature-images': { memberId: ids.memberId, pngBase64: this.pngBase64 },
      'POST /api/waivers/signature-images': { memberId: ids.memberId, pngBase64: this.pngBase64 },
    };
    return routeKey(route) in table ? [table[routeKey(route)]] : undefined;
  }

  /** Every request of the caller's credentials against the target's IDs, answered 4xx and without anything the target holds. */
  async aimAtTarget(route: Route, results: string[]) {
    const { from, to, target } = this;
    const aim: Aim = { target, optionalIds: true, revision: await this.revisionOf(route, to, target) };
    const path = pathFor(route, target), names = pathParams(route);
    const url = path + queryOf(route, aim);
    const bodies = route.method === 'GET' || route.method === 'DELETE' && !hasJsonBody(route) ? [undefined] : this.overrides(route) ?? (hasJsonBody(route) ? bodiesOf(route, aim) : [{}]);
    // A request that names the target in its query, as a filter, is aimed at it too.
    const filtered = namesTarget(Object.fromEntries(new URLSearchParams(url.split('?')[1] ?? '')), target);
    for (const body of bodies) {
      // The caller's credentials on its own hostname with the target's IDs, and on the target's hostname.
      for (const [where, origin] of [['own host', from.origin], ['foreign host', to.origin]] as const) {
        const client = this.credentials(route, origin);
        if (!client) continue;
        // A parameterless signed-link GET on its own host shows the caller's own data.
        // A document GET naming the other gym's template must instead reach the refusal checks below.
        if (where === 'own host' && route.kind === 'signed_link' && route.method === 'GET' && !names.length) {
          const own = await client.request(url);
          expect(own.status, `${routeKey(route)}: ${own.text}`).toBe(200);
          for (const secret of target.secrets) expect(own.text, `${routeKey(route)} leaks`).not.toContain(secret);
          continue;
        }
        // On its own host a route with no ID in its path, and nothing of the target in its body or query, shows only the caller's
        // own data (the reads sweep checks the lists, and the other gym's hostname refuses the rest).
        if (where === 'own host' && !names.length && !filtered && !namesTarget(body, target) && !(routeKey(route) in refusedWith200)) continue;
        const response = await client.request(url, route.method, body);
        results.push(`${from.slug}->${to.slug} ${where} ${routeKey(route)} ${response.status}`);
        const detail = `${from.slug}'s credentials against ${to.slug} (${where}): ${routeKey(route)}: ${response.status} ${response.text}`;
        if (where === 'own host' && routeKey(route) in refusedWith200) {
          expect(response.status, detail).toBe(200);
          expect(JSON.parse(response.text), detail).toEqual(refusedWith200[routeKey(route)]);
        } else if (route.method === 'GET' && where === 'own host' && !names.length) expect(response.status, detail).toBeLessThan(500);
        else expect(unreached, detail).toContain(response.status);
        for (const secret of target.secrets) expect(response.text, detail).not.toContain(secret);
      }
    }
  }

  /** The caller's own record in the path, and the target's records in the body: a route that checks the path's gym but not the
   * body's would join the two gyms. */
  async aimOwnPath(route: Route, statuses: Map<number, number>): Promise<string[]> {
    const { from, target, own } = this;
    const client = this.credentials(route, from.origin);
    if (!client || !pathParams(route).length || route.kind === 'signed_link' || !hasJsonBody(route)) return [];
    const aim: Aim = { target, optionalIds: true, revision: await this.revisionOf(route, from, own) };
    const bodies = bodiesOf(route, aim).filter((body) => namesTarget(body, target));
    if (!bodies.length) return [];
    const probed: string[] = [];
    for (const body of bodies) {
      const response = await client.request(pathFor(route, own) + queryOf(route, { ...aim, target: own }), route.method, body);
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      probed.push(`${from.slug} ${routeKey(route)} ${response.status}`);
      const detail = `${from.slug}'s own ${routeKey(route)} with ${this.to.slug}'s IDs in the body: ${response.status} ${response.text}`;
      expect(unreached, detail).toContain(response.status);
      for (const secret of target.secrets) expect(response.text, detail).not.toContain(secret);
    }
    return probed;
  }
}

/** Reads that take no ID show only the caller's own gym, to every kind of credential, with or without a filter naming the target. */
async function sweepReads(from: Context, own: Target, target: Target, routes: Route[], open: Route[]) {
  for (const route of [...routes, ...open]) {
    if (route.method !== 'GET' || route.path.includes('{')) continue;
    const client = route.kind === 'staff' ? from.owner : route.kind === 'member' ? from.household
      : route.kind === 'kiosk' ? from.device : route.kind === 'public' ? new Client(from.origin) : undefined;
    if (!client) continue;
    for (const aimed of [own, target]) {
      const response = await client.request(route.path + queryOf(route, { target: aimed, optionalIds: true }));
      expect(response.status, `${routeKey(route)}: ${response.text}`).toBeLessThan(500);
      for (const secret of target.secrets) expect(response.text, `${from.slug} ${routeKey(route)} shows ${secret}`).not.toContain(secret);
    }
  }
}

test('no route answers a gym\'s credentials with another gym\'s data, in either direction', async () => {
  test.setTimeout(900_000);
  const [alpha, beta] = await multiGyms();
  const [alphaTarget, betaTarget] = [await targetOf(alpha), await targetOf(beta)];
  const document = await alpha.owner.json<Document>('/api/openapi.json');
  // Every non-public operation is swept, except the few left out for a stated reason: a route added later is covered without a list to widen.
  const { swept, excluded, open } = routesOf(document);
  for (const entry of outOfScope) expect(excluded.some((route) => entry.pattern.test(route.path)), `nothing matches the exclusion: ${entry.reason}`).toBe(true);
  // The single-gym suite's reviewed inventory is covered too: each of its routes is swept or left out for a stated reason.
  for (const entry of inventory) if (entry.permission.kind !== 'public') expect([...swept, ...excluded].map(routeKey), 'the reviewed inventory is inside the sweep').toContain(routeKey(entry));
  test.info().annotations.push({ type: 'coverage', description: `${swept.length} non-public operations swept; ${excluded.length} left out (${outOfScope.map((entry) => entry.reason).join('; ')}); ${open.length} public` });
  console.log(`Cross-gym sweep: ${swept.length} non-public operations (${excluded.length} left out, ${open.length} public)`);
  expect(swept.length).toBeGreaterThan(200);
  // Every path ID names a real record of the target: a refusal for an ID nothing holds would prove nothing.
  for (const target of [alphaTarget, betaTarget])
    expect(swept.filter((route) => pathFor(route, target).includes(missingId)).map(routeKey), 'routes whose path names no fixture record').toEqual([]);

  // Each caller's own signed links and signature images are made first, so the gyms' full lists are compared over the sweep alone.
  const sweeps = [new Sweep(alpha, beta, alphaTarget, betaTarget, document), new Sweep(beta, alpha, betaTarget, alphaTarget, document)];
  for (const sweep of sweeps) await sweep.prepare();
  const snapshots = async () => [await snapshot(alpha, alphaTarget, swept), await snapshot(beta, betaTarget, swept)];
  const before = await snapshots();
  const results: string[] = [], statuses = new Map<number, number>(), secondPass: string[] = [];
  for (const sweep of sweeps) {
    for (const route of swept) await sweep.aimAtTarget(route, results);
    for (const route of swept) secondPass.push(...await sweep.aimOwnPath(route, statuses));
  }
  await sweepReads(alpha, alphaTarget, betaTarget, swept, open);
  await sweepReads(beta, betaTarget, alphaTarget, swept, open);
  console.log(`Cross-gym sweep: ${results.length} requests aimed at the other gym; ${secondPass.length} own-path probes (statuses ${JSON.stringify(Object.fromEntries(statuses))})`);
  expect(results.length).toBeGreaterThan(500);
  expect(secondPass.length).toBeGreaterThan(20);
  // A probe that reaches the gym check is refused for the other gym's record: a request refused for its own shape (or a missing
  // credential) would prove nothing about the boundary, so no request that reaches a gym's own host may be.
  expect([...statuses.keys()].filter((status) => status !== 404), 'own-path probes answer 404 for the other gym\'s record').toEqual([]);
  const shape = results.filter((line) => / own host /.test(line) && / (400|415|422)$/.test(line));
  expect(shape, 'own-host probes refused for the shape of their request').toEqual([]);

  // Nothing of either gym changed: the same records, at the same revisions.
  expect(await snapshots()).toEqual(before);

  // Controls: the same credentials do reach the gym's own records, so the refusals above are the gym boundary and not broken requests.
  for (const sweep of sweeps) {
    const { from: gym, own } = sweep;
    const unread: string[] = [];
    for (const route of swept.filter((entry) => entry.method === 'GET' && pathParams(entry).length && entry.kind !== 'signed_link' && entry.kind !== 'kiosk')) {
      const client = sweep.credentials(route, gym.origin)!;
      const response = await client.request(pathFor(route, own) + queryOf(route, { target: own, optionalIds: true }));
      if (response.status !== 200) unread.push(`${routeKey(route)} ${response.status}`);
    }
    // Only what a fresh gym lacks answers its own owner with 404: a photo nobody uploaded, and a signed waiver for the household login's own
    // (self-signed) waivers, which the fixture's guardian-signed one isn't.
    expect(unread.filter((line) => !/\/photo |^GET \/api\/portal\/waivers\/\{signatureId\}\/pdf /.test(line)), `${gym.slug}'s own reads`).toEqual([]);
    for (const [path, status] of [[`/api/members/${gym.student.id}`, 200], [`/api/households/${gym.householdId}`, 200], [`/api/schedule/sessions/${gym.sessionId}`, 200],
      [`/api/billing/payments`, 200], [`/api/billing/refunds`, 200], [`/api/billing/memberships/${gym.membershipId}`, 200]] as const)
      expect((await gym.owner.request(path)).status, `${gym.slug} ${path}`).toBe(status);
    expect((await gym.household.json<{ data: { id: string }[] }>('/api/portal/household/waivers')).data.map((row) => row.id)).toContain(gym.signatureId);
    expect((await gym.device.request('/api/kiosk/lookup', 'POST', { name: gym.student.fullName, pin: gym.pin })).status).toBe(200);
  }
  // A body naming the caller's own records, in the shape the second pass sends the other gym's, is accepted: the shape is valid.
  for (const gym of [alpha, beta]) {
    const session = (await gym.owner.json<{ data: { revision: number; startsAt: string; endsAt: string; name: string } }>('/api/schedule/sessions/' + gym.sessionId)).data;
    await gym.owner.json('/api/schedule/sessions/' + gym.sessionId, 'PUT', { name: session.name, startsAt: session.startsAt, endsAt: session.endsAt, coachId: null,
      capacity: 10, notes: null, kind: 'class', programIds: [gym.program.id], tagIds: [gym.classTagId], revision: session.revision });
    const template = (await gym.owner.json<{ data: { revision: number; name: string } }>('/api/schedule/templates/' + gym.scheduleTemplateId)).data;
    await gym.owner.json('/api/schedule/templates/' + gym.scheduleTemplateId, 'PUT', { name: template.name, weekday: 3, localStartTime: '12:00', durationMinutes: 60,
      coachId: null, capacity: 10, notes: null, kind: 'class', programIds: [gym.program.id], tagIds: [gym.classTagId], revision: template.revision });
    expect((await gym.owner.request(`/api/members/${gym.student.id}/tags`, 'POST', { tagId: gym.tagId })).status).toBeLessThan(300);
  }
  // Controls for the body-aimed kiosk probes, last because they record visits: a gym's own device does check in its own code.
  for (const [gym, target] of [[alpha, alphaTarget], [beta, betaTarget]] as const) {
    const scanned = await gym.device.json<{ data: { status: string } }>('/api/kiosk/checkin/qr', 'POST', { code: target.checkinCode, sessionId: null });
    expect(['checked_in', 'already_checked_in'], `${gym.slug} scans its own code`).toContain(scanned.data.status);
  }
});
