// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { test, expect, Client, missingId, type Document, type Operation, type RecordId } from '../support.js';
import { signaturePng } from '../portal.js';
import { multiGyms, withCookie, type Context } from './support.js';

interface Entry { method: string; path: string; permission: Operation['permission'] & { purpose?: string } }
const inventory: Entry[] = JSON.parse(await readFile(new URL('../authorization-inventory.json', import.meta.url), 'utf8'));
const key = (entry: Pick<Entry, 'method' | 'path'>) => `${entry.method} ${entry.path}`;

// Signed-link tokens, session cookies and device tokens are bearer credentials. Keep them out of traces.
test.use({ trace: 'off', screenshot: 'off' });

/** What one gym holds that no other gym may ever see: its resource IDs, names and addresses. */
interface Target { ids: Record<string, string>; secrets: string[]; revisions: Record<string, number>; checkinCode: string }

async function targetOf(gym: Context): Promise<Target> {
  const { owner } = gym;
  const roles = (await owner.json<{ data: (RecordId & { userId: string })[] }>('/api/staff/roles?limit=100')).data;
  const profiles = (await owner.json<{ data: RecordId[] }>('/api/staff/profiles?limit=100')).data;
  const household = (await owner.json<{ data: RecordId }>('/api/households/' + gym.householdId)).data;
  const session = (await owner.json<{ data: RecordId }>('/api/schedule/sessions/' + gym.sessionId)).data;
  const householdUsers = (await owner.json<{ data: RecordId[] }>(`/api/households/${gym.householdId}/users?limit=100`)).data;
  // An invitation nobody has accepted, so revoking one is aimed at a real record too.
  await owner.json(`/api/households/${gym.householdId}/portal-invitations`, 'POST', { email: `pending@${gym.slug}.example.invalid`, delivery: 'print', scope: 'payer' });
  const invitations = (await owner.json<{ data: RecordId[] }>(`/api/households/${gym.householdId}/portal-invitations`)).data;
  // The member's QR check-in code, issued by the household (reading it shows no code until one is issued).
  const codePath = `/api/portal/members/${gym.student.id}/checkin-code`;
  const state = (await gym.household.json<{ data: { revision: number } }>(codePath)).data;
  const checkin = (await gym.household.json<{ data: { code: string } }>(codePath, 'POST', { revision: state.revision })).data;
  expect(checkin.code).toBeTruthy();
  const ids: Record<string, string> = { memberId: gym.student.id, householdId: gym.householdId, sessionId: gym.sessionId, bookingId: gym.bookingId,
    invoiceId: gym.invoiceId, signatureId: gym.signatureId, deviceId: gym.deviceId, tagId: gym.tagId, programId: gym.program.id, rankSystemId: gym.rankSystemId,
    rankId: gym.rankId, staffRoleId: roles.at(-1)?.id ?? missingId, userId: roles.at(-1)?.userId ?? missingId, staffProfileId: profiles[0]?.id ?? missingId,
    templateId: gym.templateId, planId: gym.planId, householdUserId: householdUsers[0]?.id ?? missingId, invitationId: invitations[0]?.id ?? missingId };
  const secrets = [...new Set([...Object.values(ids).filter((value) => value !== missingId), gym.gymId, gym.name, gym.student.lastName, gym.sessionName,
    `@${gym.slug}.example.invalid`, gym.kioskToken, checkin.code])];
  return { ids, secrets, checkinCode: checkin.code,
    revisions: { household: household.revision, session: session.revision, member: gym.student.revision, program: gym.program.revision } };
}

/** The ID in `target` that a path parameter of `entry` names. Parameters with no resource of the kind in a fresh gym get an ID nothing holds. */
function idFor(entry: Entry, name: string, target: Target) {
  const { ids } = target;
  if (name === 'id') {
    const path = entry.path;
    if (path.startsWith('/api/bookings') || path.includes('/bookings/{id}')) return ids.bookingId!;
    if (path.startsWith('/api/programs')) return ids.programId!;
    if (path.startsWith('/api/rank-systems')) return ids.rankSystemId!;
    if (path.startsWith('/api/ranks')) return ids.rankId!;
    if (path.startsWith('/api/schedule/sessions')) return ids.sessionId!;
    if (path.startsWith('/api/kiosk/devices')) return ids.deviceId!;
    return missingId;
  }
  return ids[name] ?? missingId;
}
function queryFor(operation: Operation | undefined, target: Target) {
  const query = new URLSearchParams();
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString(), until = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const known: Record<string, string> = { memberId: target.ids.memberId!, programId: target.ids.programId!, rankId: target.ids.rankId!,
    rankSystemId: target.ids.rankSystemId!, sessionId: target.ids.sessionId!, householdId: target.ids.householdId!, from, until, to: until, limit: '100', offset: '0' };
  for (const parameter of operation?.parameters ?? []) if (parameter.in === 'query' && parameter.required) query.set(parameter.name, known[parameter.name] ?? 'invalid');
  const text = query.toString();
  return text ? '?' + text : '';
}

/** Valid bodies for mutations, aimed at the target's records: a route that skipped its gym check would change them.
 * Routes with no ID in their path name the target's records in the body. */
function bodies(from: Context, target: Target, images: Record<'link' | 'household', SignatureImage>): Record<string, unknown> {
  const { ids, revisions } = target;
  const promotion = { programId: ids.programId, rankId: ids.rankId, rankSystemId: ids.rankSystemId, subRank: 0, promotedAt: new Date().toISOString(), notes: null };
  const start = Date.now() + 2 * 86_400_000;
  return {
    // The caller's own name and PIN, or the target's check-in code, with the target's member: see `refusedWith200`.
    'POST /api/kiosk/checkin': { name: from.student.fullName, pin: from.pin, checkins: [{ memberId: ids.memberId, sessionId: null }] },
    'POST /api/kiosk/checkin/qr': { code: target.checkinCode, sessionId: null },
    'POST /api/portal/bookings': { sessionId: ids.sessionId, allowWaitlist: true },
    'POST /api/promotions': { ...promotion, memberId: ids.memberId },
    'POST /api/promotions/bulk': { ...promotion, memberIds: [ids.memberId] },
    'POST /api/programs': { name: 'Leaked program', rankSystemId: ids.rankSystemId, active: true },
    'POST /api/ranks': { rankSystemId: ids.rankSystemId, name: 'Leaked rank', position: 9, subRanks: [], criteria: [] },
    'POST /api/schedule/sessions': { name: 'Leaked class', startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3_600_000).toISOString(),
      coachId: null, capacity: 5, notes: null, kind: 'class', programIds: [ids.programId], tagIds: [] },
    'POST /api/schedule/templates': { name: 'Leaked template', weekday: 3, localStartTime: '12:00', durationMinutes: 60, coachId: null, capacity: 5,
      notes: null, kind: 'class', programIds: [ids.programId], tagIds: [] },
    'POST /api/staff/roles': { userId: ids.userId, role: 'coach' },
    'POST /api/staff/profiles': { displayName: 'Leaked profile', userId: ids.userId, memberId: ids.memberId },
    'POST /api/links/sign-waiver': { templateId: ids.templateId, templateVersion: 1, signer: { kind: 'guardian', name: 'Cross gym', relationship: 'Parent' },
      ...images.link, consent: true },
    'PATCH /api/members/{memberId}': { revision: revisions.member, firstName: 'Leaked' },
    'POST /api/members/{memberId}/anonymize': { revision: revisions.member },
    'PATCH /api/members/{memberId}/medical-notes': { revision: revisions.member, medicalNotes: 'Leaked' },
    'POST /api/members/{memberId}/tags': { tagId: ids.tagId },
    'PATCH /api/households/{householdId}': { revision: revisions.household, name: 'Leaked' },
    'PUT /api/households/{householdId}/pin': { revision: revisions.household, pin: '9999' },
    'DELETE /api/households/{householdId}': { revision: revisions.household },
    'POST /api/households/{householdId}/portal-invitations': { email: 'leak@example.invalid', delivery: 'print', scope: 'payer' },
    'PATCH /api/programs/{id}': { revision: revisions.program, name: 'Leaked' },
    'POST /api/schedule/sessions/{id}/cancel': { revision: revisions.session },
    'PATCH /api/schedule/sessions/{id}/notes': { revision: revisions.session, notes: 'Leaked' },
    'PATCH /api/schedule/sessions/{id}/capacity': { revision: revisions.session, capacity: 5 },
    'POST /api/attendance': { memberId: ids.memberId, sessionId: null, programId: null },
    'POST /api/bookings': { memberId: ids.memberId, sessionId: ids.sessionId, allowWaitlist: true },
    'POST /api/bookings/{id}/cancel': {},
    'POST /api/kiosk/devices/{id}/revoke': {},
    'POST /api/members': { householdId: ids.householdId, firstName: 'Leaked', lastName: 'Person' },
    'POST /api/portal/members/{memberId}/bookings': { sessionId: ids.sessionId, allowWaitlist: true },
    'POST /api/portal/members/{memberId}/bookings/{id}/cancel': {},
    'PATCH /api/portal/members/{memberId}': { revision: revisions.member, firstName: 'Leaked' },
    'POST /api/portal/invoices/{invoiceId}/checkout': {},
    'POST /api/staff/users/{userId}/reset-password': { password: 'leaked-password-for-tests' },
  };
}

const unreached = [400, 401, 403, 404, 405, 413, 415, 422, 429];
/** Kiosk check-ins answer a shared screen: a member the device can't check in is sent to the front desk, with status 200. */
const refusedWith200: Record<string, unknown> = {
  'POST /api/kiosk/checkin': { data: [{ status: 'see_front_desk' }] },
  'POST /api/kiosk/checkin/qr': { data: { status: 'see_front_desk' } },
};
interface SignatureImage { signatureImageKey: string; signatureImageHash: string }

/** Every request of `from`'s credentials against `to`'s IDs, answered 4xx and without anything `to` holds. */
async function sweep(from: Context, to: Context, target: Target, document: Document, results: string[]) {
  const links: Record<string, Client> = {};
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  for (const [purpose, extra] of [['onboarding', {}], ['update_card', {}], ['sign_waiver', { memberId: from.student.id }], ['pay_invoice', { invoiceId: from.invoiceId }]] as const) {
    const created = await from.owner.json<{ data: { token: string } }>('/api/links', 'POST', { purpose, householdId: from.householdId, expiresAt, ...extra });
    links[purpose] = new Client(from.origin, { authorization: 'Bearer ' + created.data.token });
  }
  const credentials = (entry: Entry, origin: string): Client | undefined => {
    const kind = entry.permission.kind;
    if (kind === 'staff') return withCookie(origin, from.cookies.owner);
    if (kind === 'member') return withCookie(origin, from.cookies.household);
    if (kind === 'kiosk') return new Client(origin, { authorization: 'Bearer ' + from.kioskToken });
    if (kind === 'signed_link') { const link = links[entry.permission.purpose ?? '']; return link && new Client(origin, link.headers); }
    return undefined;
  };
  // Real signature images of the caller's own, so a waiver signed for the target's member or template fails on the gym boundary.
  const image = signaturePng().toString('base64');
  const images = {
    link: (await links.sign_waiver!.json<{ data: SignatureImage }>('/api/links/sign-waiver/signature-images', 'POST', { pngBase64: image })).data,
    household: (await from.household.json<{ data: SignatureImage }>('/api/portal/household/waivers/signature-images', 'POST',
      { memberId: from.student.id, pngBase64: image })).data,
  };
  const valid = bodies(from, target, images);
  for (const entry of inventory) {
    if (entry.permission.kind === 'public') continue;
    const names = [...entry.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!);
    const path = entry.path.replace(/\{(\w+)\}/g, (_, name: string) => idFor(entry, name, target));
    const operation = document.paths[entry.path]?.[entry.method.toLowerCase()];
    const url = path + (entry.method === 'GET' ? queryFor(operation, target) : '');
    let body: unknown = entry.method === 'GET' ? undefined : valid[key(entry)] ?? {};
    // Signed-link and portal routes that name a member or an image in the body aim it at the target.
    if (entry.path.endsWith('/signature-images')) body = { memberId: target.ids.memberId, pngBase64: image };
    if (entry.path.endsWith('/waivers') && entry.method === 'POST') body = { memberId: target.ids.memberId, templateId: target.ids.templateId, templateVersion: 1,
      signer: { kind: 'guardian', name: 'Cross gym', relationship: 'Parent' }, ...images.household, consent: true };
    // The caller's credentials on its own hostname with the target's IDs, and on the target's hostname.
    for (const [where, origin] of [['own host', from.origin], ['foreign host', to.origin]] as const) {
      const client = credentials(entry, origin);
      if (!client) continue;
      // A signed link opens its own purpose only, and a GET of it on its own host shows the caller's own data.
      if (where === 'own host' && entry.permission.kind === 'signed_link' && entry.method === 'GET') {
        const own = await client.request(url);
        expect(own.status, `${key(entry)}: ${own.text}`).toBe(200);
        for (const secret of target.secrets) expect(own.text, `${key(entry)} leaks`).not.toContain(secret);
        continue;
      }
      // On its own host a route with no ID in its path is a list of the caller's own data (the reads sweep checks those),
      // unless its body names the target.
      if (where === 'own host' && !names.length && !(key(entry) in valid) && !(entry.method === 'POST' && /(signature-images|waivers)$/.test(entry.path))) continue;
      const response = await client.request(url, entry.method, body);
      results.push(`${from.slug}->${to.slug} ${where} ${entry.method} ${path} ${response.status}`);
      const detail = `${from.slug}'s credentials against ${to.slug} (${where}): ${key(entry)}: ${response.status} ${response.text}`;
      if (where === 'own host' && key(entry) in refusedWith200) {
        expect(response.status, detail).toBe(200);
        expect(JSON.parse(response.text), detail).toEqual(refusedWith200[key(entry)]);
      } else expect(unreached, detail).toContain(response.status);
      for (const secret of target.secrets) expect(response.text, detail).not.toContain(secret);
    }
  }
}

/** Reads that take no ID show only the caller's own gym, to every kind of credential. */
async function sweepReads(from: Context, own: Target, target: Target, document: Document) {
  for (const entry of inventory) {
    if (entry.method !== 'GET' || entry.path.includes('{')) continue;
    const client = entry.permission.kind === 'staff' ? from.owner : entry.permission.kind === 'member' ? from.household
      : entry.permission.kind === 'kiosk' ? from.device : entry.permission.kind === 'public' ? new Client(from.origin) : undefined;
    if (!client) continue;
    const response = await client.request(entry.path + queryFor(document.paths[entry.path]?.get, own));
    expect(response.status, `${key(entry)}: ${response.text}`).toBeLessThan(500);
    for (const secret of target.secrets) expect(response.text, `${from.slug} ${key(entry)} shows ${secret}`).not.toContain(secret);
  }
}

test('no route answers a gym\'s credentials with another gym\'s data, in either direction', async () => {
  test.setTimeout(600_000);
  const [alpha, beta] = await multiGyms();
  const [alphaTarget, betaTarget] = [await targetOf(alpha), await targetOf(beta)];
  const document = await alpha.owner.json<Document>('/api/openapi.json');
  // What the body-aimed mutations would add to a gym if they crossed over: visits, promotions, programs, classes, staff and portal access.
  const records = async (gym: Context) => Promise.all([`/api/attendance?memberId=${gym.student.id}&limit=100`, `/api/promotions?memberId=${gym.student.id}&limit=100`,
    '/api/programs?limit=100', `/api/ranks?rankSystemId=${gym.rankSystemId}&limit=100`, '/api/schedule/templates?limit=100', '/api/staff/roles?limit=100',
    '/api/staff/profiles?limit=100', `/api/households/${gym.householdId}/users?limit=100`, `/api/households/${gym.householdId}/portal-invitations`,
    `/api/bookings?memberId=${gym.student.id}&limit=100`, `/api/waivers/signatures?memberId=${gym.student.id}&limit=100`]
    .map(async (path) => [path, (await gym.owner.json<{ data: RecordId[] }>(path)).data.map((row) => row.id).sort()] as const));
  const recordsBefore = [await records(alpha), await records(beta)];
  const results: string[] = [];
  await sweep(alpha, beta, betaTarget, document, results);
  await sweep(beta, alpha, alphaTarget, document, results);
  await sweepReads(alpha, alphaTarget, betaTarget, document);
  await sweepReads(beta, betaTarget, alphaTarget, document);
  expect(results.length).toBeGreaterThan(300);

  // Controls: the same credentials do reach the gym's own records, so the refusals above are the gym boundary and not broken requests.
  for (const gym of [alpha, beta]) {
    for (const path of [`/api/members/${gym.student.id}`, `/api/households/${gym.householdId}`, `/api/schedule/sessions/${gym.sessionId}`,
      `/api/programs?limit=100`, `/api/bookings?memberId=${gym.student.id}`, `/api/attendance/totals?memberId=${gym.student.id}`])
      expect((await gym.owner.request(path)).status, `${gym.slug} ${path}`).toBe(200);
    for (const path of [`/api/portal/invoices/${gym.invoiceId}`, `/api/portal/members/${gym.student.id}`, `/api/portal/household/waivers`,
      `/api/portal/members/${gym.student.id}/bookings?limit=100&offset=0`])
      expect((await gym.household.request(path)).status, `${gym.slug} ${path}`).toBe(200);
    expect((await gym.household.json<{ data: { id: string }[] }>('/api/portal/household/waivers')).data.map((row) => row.id)).toContain(gym.signatureId);
  }

  // Nothing of the target changed.
  expect([await records(alpha), await records(beta)]).toEqual(recordsBefore);
  for (const [gym, name] of [[alpha, 'Alpha'], [beta, 'Beta']] as const) {
    const member = (await gym.owner.json<{ data: { firstName: string; lastName: string } }>('/api/members/' + gym.student.id)).data;
    expect(member).toMatchObject({ firstName: 'Casey', lastName: name + 'Student' });
    const home = (await gym.owner.json<{ data: { name: string } }>('/api/households/' + gym.householdId)).data;
    expect(home.name).toBe(`${gym.name} family`);
    const session = (await gym.owner.json<{ data: { status: string; capacity: number } }>('/api/schedule/sessions/' + gym.sessionId)).data;
    expect(session).toMatchObject({ status: 'scheduled', capacity: 10 });
    const bookings = (await gym.owner.json<{ data: { id: string; status: string }[] }>('/api/bookings?memberId=' + gym.student.id)).data;
    expect(bookings.find((booking) => booking.id === gym.bookingId)?.status).toBe('booked');
    expect((await gym.device.request('/api/kiosk/lookup', 'POST', { name: gym.student.fullName, pin: gym.pin })).status).toBe(200);
    expect((await gym.owner.json<{ data: unknown[] }>('/api/member-tags')).data.length).toBeGreaterThan(0);
    expect((await gym.household.json<{ data: { id: string } }>('/api/portal/household')).data.id).toBe(gym.householdId);
  }
  // Controls for the body-aimed kiosk probes, last because they record visits: a gym's own device does check in its own code.
  for (const [gym, target] of [[alpha, alphaTarget], [beta, betaTarget]] as const) {
    const scanned = await gym.device.json<{ data: { status: string } }>('/api/kiosk/checkin/qr', 'POST', { code: target.checkinCode, sessionId: null });
    expect(['checked_in', 'already_checked_in'], `${gym.slug} scans its own code`).toContain(scanned.data.status);
  }
});
