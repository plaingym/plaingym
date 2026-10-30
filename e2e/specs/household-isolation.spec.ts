// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { test, expect, cached, Client, demoClient, missingId, type Person, type RecordId } from '../support.js';
import { claimPortal, outboxIds, outboxLink, signaturePng } from '../portal.js';

interface Entry { method: string; path: string; permission: { kind: string; purpose?: string } }
const inventory: Entry[] = JSON.parse(await readFile(new URL('../authorization-inventory.json', import.meta.url), 'utf8'));
const key = (entry: Entry) => `${entry.method} ${entry.path}`;
interface Member extends RecordId { firstName: string; lastName: string }
/** One household's resources, read through its own portal login. */
interface Household {
  client: Client; householdId: string; members: Member[]; invoiceIds: string[]; signatureIds: string[]; bookingIds: string[];
  codeRevision: number; template: { id: string; version: number };
}

// Outbox links, signed-link tokens and check-in codes are bearer credentials. Keep them out of traces.
test.use({ trace: 'off', screenshot: 'off' });

async function read(client: Client, path: string) {
  const response = await client.request<{ data: unknown }>(path);
  expect(response.status, `${path}: ${response.text}`).toBe(200);
  return response.body.data;
}
async function household(client: Client, sessionId: string): Promise<Household> {
  const home = await read(client, '/api/portal/household') as { id: string };
  const members = await read(client, '/api/portal/members') as Member[];
  const member = members[0]!;
  const invoiceIds = (await read(client, '/api/portal/invoices?limit=100&offset=0') as RecordId[]).map(row => row.id);
  const signatures = await read(client, '/api/portal/household/waivers') as { id: string }[];
  const templates = await read(client, '/api/portal/household/waivers/pending') as { template?: { id: string; version: number } }[];
  // A booking of its own, so the other household has a booking ID to try.
  const booked = await client.request<{ data: RecordId }>(`/api/portal/members/${member.id}/bookings`, 'POST', { sessionId, allowWaitlist: true });
  expect([200, 409], booked.text).toContain(booked.status);
  const bookingIds = (await read(client, `/api/portal/members/${member.id}/bookings?limit=100&offset=0`) as RecordId[]).map(row => row.id);
  const code = await read(client, `/api/portal/members/${member.id}/checkin-code`) as { revision: number };
  const template = templates.find(row => row.template)?.template ?? { id: missingId, version: 1 };
  return { client, householdId: home.id, members, invoiceIds, signatureIds: signatures.map(row => row.id), bookingIds, codeRevision: code.revision, template };
}
/** Every identifier and name of the household that must never appear in another household's responses. */
const secrets = (target: Household) => [target.householdId, ...target.members.flatMap(member => [member.id, `${member.firstName} ${member.lastName}`]),
  ...target.invoiceIds, ...target.signatureIds, ...target.bookingIds];

/** Each portal route with a path parameter, aimed at the other household's resources, with a valid body. */
async function sweepPortal(own: Household, target: Household, sessionId: string, results: string[]) {
  const foreign = target.members[0]!, image = signaturePng().toString('base64');
  // Every member, and one of each other resource: receipts and invoice Checkout allow ten requests a minute per address.
  const values: Record<string, string[]> = { memberId: target.members.map(member => member.id), invoiceId: target.invoiceIds.slice(0, 1),
    signatureId: target.signatureIds.slice(0, 1), id: target.bookingIds.slice(0, 1) };
  const signing = { templateId: target.template.id, templateVersion: target.template.version, signer: { kind: 'self', name: 'Cross household' },
    signatureImageKey: 'cross-household', signatureImageHash: '0'.repeat(64), consent: true };
  const bodies: Record<string, unknown> = {
    'PATCH /api/portal/members/{memberId}': { revision: 1, firstName: 'Leaked' },
    'POST /api/portal/members/{memberId}/checkin-code': { revision: target.codeRevision },
    'POST /api/portal/members/{memberId}/bookings': { sessionId, allowWaitlist: true },
  };
  // Routes that name a member in the body instead of the path.
  const bodyTargets: Record<string, unknown> = {
    'POST /api/portal/waivers': { memberId: foreign.id, ...signing },
    'POST /api/portal/household/waivers': { memberId: foreign.id, ...signing },
    'POST /api/portal/waivers/signature-images': { memberId: foreign.id, pngBase64: image },
    'POST /api/portal/household/waivers/signature-images': { memberId: foreign.id, pngBase64: image },
  };
  for (const entry of inventory.filter(item => item.permission.kind === 'member')) {
    const names = [...entry.path.matchAll(/\{(\w+)\}/g)].map(match => match[1]!);
    if (!names.length && !(key(entry) in bodyTargets)) continue;
    // A route with a member and a booking also tries the caller's own member with the other household's booking.
    const combinations: Record<string, string>[] = names.length === 2
      ? [{ memberId: foreign.id, id: target.bookingIds[0]! }, { memberId: own.members[0]!.id, id: target.bookingIds[0]! }]
      : names.length ? (values[names[0]!] ?? []).map(value => ({ [names[0]!]: value })) : [{}];
    expect(combinations.length, `${key(entry)} has resources to try`).toBeGreaterThan(0);
    for (const combination of combinations) {
      const path = entry.path.replace(/\{(\w+)\}/g, (_, name: string) => combination[name]!);
      const body = bodyTargets[key(entry)] ?? bodies[key(entry)] ?? (entry.method === 'GET' ? undefined : {});
      const response = await own.client.request(path, entry.method, body);
      results.push(`${entry.method} ${path} ${response.status}`);
      expect([403, 404], `${entry.method} ${entry.path} for ${JSON.stringify(combination)}: ${response.text}`).toContain(response.status);
      for (const secret of secrets(target)) expect(response.text, `${key(entry)} leaks`).not.toContain(secret);
    }
  }
}
/** Every portal read without a path parameter shows only the caller's household. */
async function sweepReads(own: Household, target: Household) {
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString(), to = new Date(Date.now() + 14 * 86_400_000).toISOString();
  for (const entry of inventory.filter(item => item.permission.kind === 'member' && item.method === 'GET' && !item.path.includes('{'))) {
    const query = entry.path === '/api/portal/schedule' ? `?from=${from}&to=${to}&limit=100&offset=0`
      : ['/api/portal/invoices', '/api/portal/bookings'].includes(entry.path) ? '?limit=100&offset=0' : '';
    const response = await own.client.request(entry.path + query);
    // The self routes answer 404 to a payer login that has no member profile of its own.
    expect(entry.path === '/api/portal/bookings' || entry.path.startsWith('/api/portal/waivers') ? [200, 404] : [200, 503],
      `${key(entry)}: ${response.text}`).toContain(response.status);
    for (const secret of secrets(target)) expect(response.text, `${key(entry)} leaks`).not.toContain(secret);
  }
}

test('household A and B logins, signed links, PINs and QR codes are refused on each other\'s portal and signed-link resources', async ({ sandboxes }, info) => {
  test.setTimeout(300_000);
  const sandbox = sandboxes[0]!, owner = await demoClient(sandbox, 'owner');
  // Household A is the sandbox's student. Household B is the seeded Chen family (Daniel and Ava, with a guardian-signed
  // waiver and invoices), which gets its own portal login through an invitation.
  const studentClient = await demoClient(sandbox, 'student');
  const daniel = (await owner.json<{ data: Person[] }>('/api/members?search=Chen')).data.find(person => person.firstName === 'Daniel')!;
  const family = (await owner.json<{ data: RecordId & { email: string | null } }>('/api/households/' + daniel.householdId)).data;
  expect(family.email).not.toBeNull();
  const studentHome = (await read(studentClient, '/api/portal/household') as RecordId).id;
  const familyClient = new Client(sandbox.origin);
  familyClient.cookie = await cached(`login:${sandbox.gymId}:family`, async () => {
    const invitation = await owner.json<{ data: { invitationUrl: string } }>(`/api/households/${family.id}/portal-invitations`, 'POST',
      { email: family.email, delivery: 'print', scope: 'payer' });
    const before = await outboxIds(owner);
    const accepted = await new Client(sandbox.origin).json<{ data: { status: string } }>('/api/portal/invitations/accept', 'POST',
      { token: new URL(invitation.data.invitationUrl).hash.slice(1) });
    expect(accepted.data.status).toBe('email_sent');
    return (await claimPortal(sandbox.origin, await outboxLink(owner, family.email!, /^\/api\/auth\//, before))).cookie;
  });

  const from = new Date(Date.now() + 3 * 3_600_000).toISOString(), until = new Date(Date.now() + 8 * 86_400_000).toISOString();
  const sessions = (await owner.json<{ data: (RecordId & { capacity: number | null; status: string })[] }>(
    `/api/schedule/sessions?from=${from}&until=${until}&status=scheduled&limit=100`)).data.filter(session => session.capacity !== null);
  expect(sessions.length).toBeGreaterThan(1);
  const a = await household(studentClient, sessions[0]!.id), b = await household(familyClient, sessions[1]!.id);
  expect(a.householdId).toBe(studentHome);
  expect(b.householdId).toBe(family.id);
  // Each household has every kind of resource the sweep aims at.
  for (const target of [a, b]) for (const ids of [target.invoiceIds, target.signatureIds, target.bookingIds]) expect(ids.length).toBeGreaterThan(0);

  // Portal logins, both ways: every member route with a path parameter, and every member read.
  const results: string[] = [];
  await sweepPortal(a, b, sessions[0]!.id, results);
  await sweepPortal(b, a, sessions[1]!.id, results);
  await sweepReads(a, b);
  await sweepReads(b, a);
  await info.attach('cross-household-results', { body: results.join('\n'), contentType: 'text/plain' });
  // Nothing changed for household B.
  expect((await read(familyClient, `/api/portal/members/${b.members[0]!.id}`) as Member).firstName).toBe(b.members[0]!.firstName);

  // Signed links: household A's links reach only A, and never B's members, waivers or images.
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const dueOn = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const bill = (await owner.json<{ data: RecordId & { currency: string } }>('/api/billing/invoices/one-off', 'POST', { householdId: a.householdId, dueOn,
    source: 'custom', description: 'Cross-household check', currency: 'USD', amountCents: 1000, taxRateIds: [] })).data;
  const tokens: Record<string, string> = {};
  for (const [purpose, extra] of [['onboarding', {}], ['update_card', {}], ['sign_waiver', { memberId: a.members[0]!.id }], ['pay_invoice', { invoiceId: bill.id }]] as const) {
    const created = await owner.json<{ data: { token: string } }>('/api/links', 'POST', { purpose, householdId: a.householdId, expiresAt, ...extra });
    tokens[purpose] = created.data.token;
  }
  const foreign = b.members[0]!.id, image = signaturePng().toString('base64');
  for (const entry of inventory.filter(item => item.permission.kind === 'signed_link')) {
    for (const [purpose, token] of Object.entries(tokens)) {
      const link = new Client(sandbox.origin, { authorization: 'Bearer ' + token });
      const body = entry.method === 'GET' ? undefined
        : entry.path.endsWith('/signature-images') ? { memberId: foreign, pngBase64: image }
          : entry.path === '/api/links/onboarding/waivers' ? { memberId: foreign, templateId: b.template.id, templateVersion: b.template.version,
            signer: { kind: 'self', name: 'Cross household' }, signatureImageKey: 'cross-household', signatureImageHash: '0'.repeat(64), consent: true }
            : {};
      const response = await link.request(entry.path, entry.method, body);
      const detail = `${key(entry)} with a ${purpose} link: ${response.status} ${response.text}`;
      for (const secret of secrets(b)) expect(response.text, detail).not.toContain(secret);
      // A link opens only the routes of its own purpose; on them, the other household's member is never found.
      if (purpose !== entry.permission.purpose) expect([401, 403, 404], detail).toContain(response.status);
      // A sign-waiver link fixes its member, so its routes take no member at all and refuse a body that names one.
      else if (entry.path.startsWith('/api/links/sign-waiver/') && body) expect(response.status, detail).toBe(400);
      else if (body && typeof body === 'object' && 'memberId' in body) expect([403, 404], detail).toContain(response.status);
      else if (entry.method === 'GET') expect(response.status, detail).toBe(200);
      // Its own actions run for household A only (or refuse the empty body); none may fail unhandled.
      else expect(response.status, detail).toBeLessThan(500);
    }
  }
  for (const token of Object.values(tokens)) {
    const page = await new Client(sandbox.origin).request('/l/' + token);
    for (const secret of secrets(b)) expect(page.text, 'signed-link page').not.toContain(secret);
  }

  // Kiosk PIN: household A's PIN finds only A's people and checks in only A's members.
  const studentMember = a.members[0]!, familyMember = b.members[0]!;
  const attendanceOf = async () => (await owner.json<{ data: RecordId[] }>(`/api/attendance?memberId=${familyMember.id}&limit=100`)).data.map(row => row.id).sort();
  const familyAttendance = await attendanceOf();
  const home = await owner.json<{ data: RecordId }>('/api/households/' + a.householdId);
  await owner.json(`/api/households/${a.householdId}/pin`, 'PUT', { revision: home.data.revision, pin: '8642' });
  const device = new Client(sandbox.origin, { authorization: 'Bearer ' + sandbox.kioskToken });
  const own = await device.json('/api/kiosk/lookup', 'POST', { name: `${studentMember.firstName} ${studentMember.lastName}`, pin: '8642' });
  expect(JSON.stringify(own)).toContain(studentMember.id);
  const lookup = await device.json('/api/kiosk/lookup', 'POST', { name: `${familyMember.firstName} ${familyMember.lastName}`, pin: '8642' });
  expect(lookup).toEqual({ data: { status: 'see_front_desk' } });
  const forged = await device.json<{ data: { status: string }[] }>('/api/kiosk/checkin', 'POST',
    { name: `${studentMember.firstName} ${studentMember.lastName}`, pin: '8642', checkins: [{ memberId: familyMember.id, sessionId: null }] });
  expect(forged.data).toEqual([{ status: 'see_front_desk' }]);

  // QR code: household A's code checks in only A's member, and a replaced code stops working.
  const code = await read(studentClient, `/api/portal/members/${studentMember.id}/checkin-code`) as { code: string; revision: number };
  const scan = async (value: string) => (await device.json<{ data: { status: string; member?: { id: string } } }>('/api/kiosk/checkin/qr', 'POST', { code: value, sessionId: null })).data;
  const scanned = await scan(code.code);
  expect(scanned.member?.id).toBe(studentMember.id);
  expect(JSON.stringify(scanned)).not.toContain(familyMember.id);
  await studentClient.json(`/api/portal/members/${studentMember.id}/checkin-code`, 'POST', { revision: code.revision });
  expect(await scan(code.code)).toEqual({ status: 'see_front_desk' });
  // Neither household A's PIN nor its QR code recorded a visit for household B.
  expect(await attendanceOf()).toEqual(familyAttendance);
});
