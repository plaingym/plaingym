// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { test, expect, cached, Client, demoClient, missingId, type Document, type Person, type RecordId, type Sandbox, type Schema } from '../support.js';
import { claimPortal, outboxIds, outboxLink, signaturePng } from '../portal.js';

interface Entry { method: string; path: string; permission: { kind: string; purpose?: string } }
const inventory: Entry[] = JSON.parse(await readFile(new URL('../authorization-inventory.json', import.meta.url), 'utf8'));
const key = (entry: Entry) => `${entry.method} ${entry.path}`;
// Current templates belong to the gym. Signed records below remain household-private.
// Positive PDF reads by two households are exercised in waivers.spec.ts.
const currentTemplateReads = new Set([
  'GET /api/portal/waiver-templates/{templateId}/document',
  'GET /api/portal/household/waiver-templates/{templateId}/document',
]);
interface Member extends RecordId { firstName: string; lastName: string }
/** One household's resources, read through its own portal login. */
interface Household {
  client: Client; householdId: string; members: Member[]; invoiceIds: string[]; signatureIds: string[]; bookingIds: string[];
  codeRevision: number; template: { id: string; version: number };
}

// Outbox links, signed-link tokens and check-in codes are bearer credentials. Keep them out of traces.
test.use({ trace: 'off', screenshot: 'off' });

async function read(client: Client, path: string) {
  const response = await client.request<{ data: unknown; householdId: string }>(path);
  expect(response.status, `${path}: ${response.text}`).toBe(200);
  if (!path.includes('/bookings')) {
    const expected = path === '/api/portal/household' ? (response.body.data as RecordId).id : client.headers['X-Portal-Household'];
    expect(response.body.householdId, path).toBe(expected);
  }
  return response.body.data;
}
async function household(client: Client, sessionId: string): Promise<Household> {
  const home = await read(client, '/api/portal/household') as { id: string };
  client.headers['X-Portal-Household'] = home.id;
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
    if (currentTemplateReads.has(key(entry))) continue;
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
/** Every portal read shows only the caller's household and identifies it (booking answers are not cached by portal pages). */
async function sweepReads(own: Household, target: Household) {
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString(), to = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const ids: Record<string, string> = { memberId: own.members[0]!.id, invoiceId: own.invoiceIds[0] ?? missingId,
    signatureId: own.signatureIds[0] ?? missingId, id: own.bookingIds[0] ?? missingId, templateId: own.template.id };
  for (const entry of inventory.filter(item => item.permission.kind === 'member' && item.method === 'GET')) {
    const query = entry.path === '/api/portal/schedule' ? `?from=${from}&to=${to}&limit=100&offset=0`
      : ['/api/portal/invoices', '/api/portal/bookings'].includes(entry.path) ? '?limit=100&offset=0' : '';
    const response = await own.client.request(entry.path.replace(/\{(\w+)\}/g, (_, name: string) => ids[name]!) + query);
    // The self routes answer 404 to a payer login that has no member profile of its own.
    // An invoice that isn't paid yet has no receipt (409), and which of the household's invoices comes first isn't fixed.
    expect(entry.path.endsWith('/receipt') ? [200, 404, 409, 503] : entry.path.includes('{') ? [200, 404, 503] : entry.path === '/api/portal/bookings' || entry.path.startsWith('/api/portal/waivers') ? [200, 404] : [200, 503],
      `${key(entry)}: ${response.text}`).toContain(response.status);
    if (response.status === 200 && !entry.path.includes('/bookings')) expect((response.body as { householdId: string }).householdId, key(entry)).toBe(own.householdId);
    for (const secret of secrets(target)) expect(response.text, `${key(entry)} leaks`).not.toContain(secret);
  }
}

/** The seeded Chen family (Daniel and Ava, with a guardian-signed waiver and invoices), signed in through its own payer login. */
async function familyLogin(sandbox: Sandbox, owner: Client) {
  const daniel = (await owner.json<{ data: Person[] }>('/api/members?search=Chen')).data.find(person => person.firstName === 'Daniel')!;
  const family = (await owner.json<{ data: RecordId & { email: string | null } }>('/api/households/' + daniel.householdId)).data;
  expect(family.email).not.toBeNull();
  const client = new Client(sandbox.origin);
  client.cookie = await cached(`login:${sandbox.gymId}:family`, async () => {
    const invitation = await owner.json<{ data: { invitationUrl: string } }>(`/api/households/${family.id}/portal-invitations`, 'POST',
      { email: family.email, delivery: 'print', scope: 'payer' });
    const before = await outboxIds(owner);
    const accepted = await new Client(sandbox.origin).json<{ data: { status: string } }>('/api/portal/invitations/accept', 'POST',
      { token: new URL(invitation.data.invitationUrl).hash.slice(1) });
    expect(accepted.data.status).toBe('email_sent');
    return (await claimPortal(sandbox.origin, await outboxLink(owner, family.email!, /^\/api\/auth\//, before))).cookie;
  });
  return { family, client };
}

test('household A and B logins, signed links, PINs and QR codes are refused on each other\'s portal and signed-link resources', async ({ sandboxes }, info) => {
  test.setTimeout(300_000);
  const sandbox = sandboxes[0]!, owner = await demoClient(sandbox, 'owner');
  // Household A is the sandbox's student. Household B is the seeded Chen family (Daniel and Ava, with a guardian-signed
  // waiver and invoices), which gets its own portal login through an invitation.
  const studentClient = await demoClient(sandbox, 'student');
  const { family, client: familyClient } = await familyLogin(sandbox, owner);
  const studentHome = (await read(studentClient, '/api/portal/household') as RecordId).id;

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
      const path = entry.path.replace('{templateId}', a.template.id);
      const response = await link.request(path, entry.method, body);
      const detail = `${key(entry)} with a ${purpose} link: ${response.status} ${response.text}`;
      for (const secret of secrets(b)) expect(response.text, detail).not.toContain(secret);
      // A link opens only the routes of its own purpose; on them, the other household's member is never found.
      if (purpose !== entry.permission.purpose) expect([401, 403, 404], detail).toContain(response.status);
      // A sign-waiver link fixes its member, so its routes take no member at all and refuse a body that names one.
      else if (entry.path.startsWith('/api/links/sign-waiver/') && body) expect(response.status, detail).toBe(400);
      else if (body && typeof body === 'object' && 'memberId' in body) expect([403, 404], detail).toContain(response.status);
      // Seeded demo templates are text, so they have no uploaded document.
      else if (entry.path === '/api/links/sign-waiver/templates/{templateId}/document') expect(response.status, detail).toBe(404);
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

/** A record ID that belongs to one household: a request naming two of them must keep them in the same household. */
const householdScoped = /^(member|household|invoice|signature|booking|membership|payment|refund|paymentMethod|link|householdUser|invitation|attendance)Ids?$/;
/** The household-scoped record IDs an operation takes in its path, query and JSON body. */
function scopedNames(path: string, method: string, document: Document) {
  const operation = document.paths[path]![method.toLowerCase()]!;
  const names = new Set([...path.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).filter(name => householdScoped.test(name)));
  for (const parameter of operation.parameters ?? []) if (parameter.in === 'query' && householdScoped.test(parameter.name)) names.add(parameter.name);
  // Named schemas appear as `$ref`s to the document's components, and intersections as `allOf`.
  type Node = Schema & { $ref?: string; allOf?: Node[] };
  const components = (document as Document & { components?: { schemas?: Record<string, Node> } }).components?.schemas ?? {};
  const seen = new Set<Node>();
  const walk = (schema: Node | undefined) => {
    if (!schema || seen.has(schema)) return;
    seen.add(schema);
    if (schema.$ref) walk(components[schema.$ref.replace('#/components/schemas/', '')]);
    for (const [name, property] of Object.entries(schema.properties ?? {})) { if (householdScoped.test(name)) names.add(name); walk(property); }
    walk(schema.items);
    for (const option of [...schema.anyOf ?? [], ...schema.oneOf ?? [], ...schema.allOf ?? []]) walk(option);
  };
  walk(operation.requestBody?.content['application/json']?.schema);
  return [...names];
}

test('a household login can neither open another household nor name it in a header or a query', async ({ sandboxes }) => {
  test.setTimeout(180_000);
  const sandbox = sandboxes[0]!, owner = await demoClient(sandbox, 'owner'), student = await demoClient(sandbox, 'student');
  const { family, client: familyClient } = await familyLogin(sandbox, owner);
  const own = (await read(student, '/api/portal/household') as RecordId).id;
  familyClient.headers['X-Portal-Household'] = family.id;
  const theirs = {
    members: await read(familyClient, '/api/portal/members') as Member[],
    invoiceIds: (await read(familyClient, '/api/portal/invoices?limit=100&offset=0') as RecordId[]).map(row => row.id),
    signatureIds: (await read(familyClient, '/api/portal/household/waivers') as RecordId[]).map(row => row.id),
  };
  for (const ids of [theirs.members, theirs.invoiceIds, theirs.signatureIds]) expect(ids.length).toBeGreaterThan(0);
  const secrets = [family.id, ...theirs.members.flatMap(member => [member.id, `${member.firstName} ${member.lastName}`]), ...theirs.invoiceIds, ...theirs.signatureIds];
  const ids: Record<string, string> = { memberId: theirs.members[0]!.id, invoiceId: theirs.invoiceIds[0]!, signatureId: theirs.signatureIds[0]!, id: missingId, templateId: missingId };
  const unleaked = (text: string, detail: string) => { for (const secret of secrets) expect(text, `${detail} leaks household B`).not.toContain(secret); };

  // Household A's login can't choose household B, which its household list doesn't show; it stays in household A.
  const chosen = await student.request('/api/portal/households/current', 'POST', { householdId: family.id });
  expect([403, 404], `choosing household B: ${chosen.status}`).toContain(chosen.status);
  unleaked(chosen.text, 'choosing household B');
  const listed = await student.request('/api/portal/households');
  expect(listed.status).toBe(200);
  unleaked(listed.text, 'the household list');
  expect((await student.json<{ householdId: string }>('/api/portal/context')).householdId).toBe(own);

  // Naming household B in the portal's household header opens nothing of it, on any portal route, aimed at B's records.
  const naming = new Client(sandbox.origin, { 'X-Portal-Household': family.id });
  naming.cookie = student.cookie;
  for (const entry of inventory.filter(item => item.permission.kind === 'member')) {
    const path = entry.path.replace(/\{(\w+)\}/g, (_, name: string) => ids[name] ?? missingId);
    const response = await naming.request(path, entry.method, entry.method === 'GET' ? undefined : {});
    expect.soft([403, 404, 409], `${key(entry)} naming household B: ${response.status}`).toContain(response.status);
    unleaked(response.text, key(entry));
  }

  // Portal reads that filter by a record in their query refuse household B's, from household A's own context.
  const document = await new Client(sandbox.origin).json<Document>('/api/openapi.json');
  const required: Record<string, string> = { limit: '100', offset: '0', from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    to: new Date(Date.now() + 14 * 86_400_000).toISOString() };
  let filtered = 0;
  for (const entry of inventory.filter(item => item.permission.kind === 'member' && item.method === 'GET')) {
    const parameters = (document.paths[entry.path]?.get?.parameters ?? []).filter(parameter => parameter.in === 'query');
    const aimed = parameters.filter(parameter => householdScoped.test(parameter.name));
    if (!aimed.length || entry.path.includes('{')) continue;
    for (const parameter of aimed) {
      const query = new URLSearchParams({ [parameter.name]: ids[parameter.name] ?? missingId });
      for (const other of parameters) if (other.required && other.name !== parameter.name) query.set(other.name, required[other.name] ?? missingId);
      const response = await student.request(`${entry.path}?${query}`);
      expect.soft([403, 404], `${key(entry)} filtered by household B's ${parameter.name}: ${response.status}`).toContain(response.status);
      unleaked(response.text, key(entry));
      filtered++;
    }
  }
  expect(filtered, 'portal reads that filter by a household record').toBeGreaterThan(0);
});

test('staff requests that join two households\' records are refused and change neither household', async ({ sandboxes }, info) => {
  test.setTimeout(180_000);
  const sandbox = sandboxes[0]!, owner = await demoClient(sandbox, 'owner'), student = await demoClient(sandbox, 'student');
  const { family, client: familyClient } = await familyLogin(sandbox, owner);
  const own = (await read(student, '/api/portal/household') as RecordId).id;
  familyClient.headers['X-Portal-Household'] = family.id;
  student.headers['X-Portal-Household'] = own;
  const memberA = (await read(student, '/api/portal/members') as Member[])[0]!.id, memberB = (await read(familyClient, '/api/portal/members') as Member[])[0]!.id;
  const invoiceB = (await read(familyClient, '/api/portal/invoices?limit=100&offset=0') as RecordId[])[0]!.id;
  type Login = RecordId & { userId: string };
  const logins = async (householdId: string) => (await owner.json<{ data: Login[] }>(`/api/households/${householdId}/users?limit=100`)).data;
  const loginA = (await logins(own))[0]!, loginB = (await logins(family.id))[0]!;
  // An invitation household B hasn't accepted yet, and a card saved by a household other than A.
  const pending = `pending-${crypto.randomUUID()}@example.invalid`;
  await owner.json(`/api/households/${family.id}/portal-invitations`, 'POST', { email: pending, delivery: 'print', scope: 'payer' });
  const invitationB = (await owner.json<{ data: { id: string; email: string }[] }>(`/api/households/${family.id}/portal-invitations`)).data
    .find(row => row.email === pending)!.id;
  let card: { householdId: string; id: string } | undefined;
  for (const home of (await owner.json<{ data: RecordId[] }>('/api/households?limit=100')).data) {
    if (home.id === own) continue;
    const methods = (await owner.json<{ data: RecordId[] }>(`/api/billing/households/${home.id}/payment-methods?limit=100`)).data;
    if (methods.length) { card = { householdId: home.id, id: methods[0]!.id }; break; }
  }
  expect(card, 'a seeded household other than A has a saved card').toBeDefined();
  const planId = (await owner.json<{ data: RecordId[] }>('/api/billing/plans?limit=100')).data[0]!.id;
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString(), startsOn = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

  // Each request names a record of household A beside one of household B's (or the other way round).
  const cases: { key: string; path: string; method: string; body?: unknown }[] = [
    { key: 'DELETE /api/households/{householdId}/portal-invitations/{invitationId}', method: 'DELETE', path: `/api/households/${own}/portal-invitations/${invitationB}` },
    { key: 'DELETE /api/households/{householdId}/users/{householdUserId}', method: 'DELETE', path: `/api/households/${own}/users/${loginB.id}` },
    { key: 'DELETE /api/households/{householdId}/users/{householdUserId}', method: 'DELETE', path: `/api/households/${family.id}/users/${loginA.id}` },
    { key: 'POST /api/households/{householdId}/users/{householdUserId}/password', method: 'POST', path: `/api/households/${own}/users/${loginB.id}/password`,
      body: { newPassword: 'cross-household-password' } },
    { key: 'POST /api/households/{householdId}/users', method: 'POST', path: `/api/households/${own}/users`, body: { userId: loginB.userId, scope: 'member', memberId: memberB } },
    { key: 'POST /api/households/{householdId}/portal-invitations', method: 'POST', path: `/api/households/${own}/portal-invitations`,
      body: { email: `cross-${crypto.randomUUID()}@example.invalid`, delivery: 'print', scope: 'member', memberId: memberB } },
    { key: 'POST /api/billing/memberships', method: 'POST', path: '/api/billing/memberships',
      body: { householdId: own, memberId: memberB, planId, startsOn, nextDueOn: startsOn, firstPeriod: 'next_billing_date' } },
    { key: 'POST /api/billing/households/{householdId}/payment-methods/{paymentMethodId}/default', method: 'POST',
      path: `/api/billing/households/${own}/payment-methods/${card!.id}/default`, body: {} },
    { key: 'POST /api/billing/households/{householdId}/payment-methods/{paymentMethodId}/revoke', method: 'POST',
      path: `/api/billing/households/${own}/payment-methods/${card!.id}/revoke`, body: {} },
    ...['/api/links', '/api/links/send'].flatMap(path => [
      { purpose: 'sign_waiver', memberId: memberB }, { purpose: 'pay_invoice', invoiceId: invoiceB },
    ].map(resource => ({ key: 'POST ' + path, method: 'POST', path,
      body: { householdId: own, expiresAt, ...resource, ...path.endsWith('/send') ? { sendGeneration: crypto.randomUUID() } : {} } }))),
    ...[{ purpose: 'sign_waiver', recipients: [{ householdId: own, memberId: memberB }] }, { purpose: 'pay_invoice', recipients: [{ householdId: own, invoiceId: invoiceB }] }]
      .map(resource => ({ key: 'POST /api/link-campaigns', method: 'POST', path: '/api/link-campaigns',
        body: { name: 'Cross-household ' + resource.purpose, expiresAt, reminderSchedule: [], ...resource } })),
  ];
  // A list filtered by both households' records holds nothing.
  const filters = 'GET /api/billing/memberships';

  // Every staff operation that takes two household records is tried: one added later fails here until it is.
  const document = await new Client(sandbox.origin).json<Document>('/api/openapi.json');
  const joining = inventory.filter(entry => entry.permission.kind === 'staff' && document.paths[entry.path]?.[entry.method.toLowerCase()]
    && scopedNames(entry.path, entry.method, document).length > 1).map(key).sort();
  expect(joining, 'staff operations that take two household records').toEqual([...new Set([...cases.map(item => item.key), filters])].sort());

  const state = async () => Object.fromEntries(await Promise.all([
    `/api/households/${family.id}/portal-invitations`, `/api/households/${family.id}/users?limit=100`, `/api/households/${own}/users?limit=100`,
    `/api/billing/households/${card!.householdId}/payment-methods?limit=100`, `/api/billing/memberships?householdId=${family.id}&limit=100`,
    `/api/links?householdId=${family.id}&limit=100`,
  ].map(async path => [path, (await owner.json<{ data: unknown }>(path)).data] as const)));
  const before = await state(), results: string[] = [];
  for (const item of cases) {
    const response = await owner.request(item.path, item.method, item.body);
    results.push(`${item.key} ${response.status}`);
    // Sending refuses before it looks at the records while member email is off, as it is in the demo; it shares the household check
    // with creating a link, and its unit tests cover that check.
    const refused = item.key === 'POST /api/links/send' ? [403, 404, 503] : [403, 404];
    expect.soft(refused, `${item.key} joining households A and B: ${response.status} ${response.text}`).toContain(response.status);
  }
  for (const query of [`householdId=${own}&memberId=${memberB}`, `householdId=${family.id}&memberId=${memberA}`]) {
    const response = await owner.request<{ data: unknown[] }>(`/api/billing/memberships?${query}&limit=100`);
    results.push(`${filters} ${response.status}`);
    if (response.status === 200) expect(response.body.data, `${filters} filtered by two households`).toEqual([]);
    else expect([403, 404], `${filters}: ${response.status}`).toContain(response.status);
  }
  await info.attach('cross-household-staff-results', { body: results.join('\n'), contentType: 'text/plain' });
  expect(await state(), 'neither household changed').toEqual(before);
});
