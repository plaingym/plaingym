// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { test, expect, Client, gymOrigin, gymTimezone, showWeek, missingId, demoClient, type Operation, type Role } from '../support.js';
import { claimPortal, outboxIds, outboxLink } from '../portal.js';
import { accessibleLayout } from '../responsive.js';

interface Entry { method: string; path: string; permission: Operation['permission']; additionalPermissions?: Operation['permission'][] }
const inventory: Entry[] = JSON.parse(await readFile(new URL('../authorization-inventory.json', import.meta.url), 'utf8'));
// Reviewed against the staff matrix, independently of the application's canStaff().
const all: Role[] = ['owner', 'admin', 'coach', 'front_desk'];
const managers: Role[] = ['owner', 'admin'];
const desk: Role[] = ['owner', 'admin', 'front_desk'];
const coaches: Role[] = ['owner', 'admin', 'coach'];
const matrix: Record<string, Role[]> = {
  'plans.manage': managers,
  'payments.record': desk,
  'announcements.send': managers,
  'reports.read': coaches,
  'reports.revenue': managers,
  'leads.manage': desk,
  'members.read': all, 'members.manage': desk, 'members.anonymize': managers, 'members.delete': managers,
  'medical.read': coaches, 'households.manage': desk, 'billing.read': desk, 'tags.manage': desk,
  'staff.manage': managers, 'settings.manage': managers, 'promotions.manage': coaches,
  'bookings.manage': all, 'schedule.manage': coaches, 'class_notes.manage': all,
  'attendance.manage': all, 'data.export': managers, 'kiosk_devices.manage': managers,
  'go_live.manage': managers, 'integrations.manage': ['owner'], 'portal_access.manage': desk,
};
const inScope = (path: string) => /^\/api\/(bookings(?:\/|$)|portal\/(?:bookings(?:\/|$)|schedule(?:\/|$)|members(?:$|\/[^/]+$|\/[^/]+\/(?:bookings|memberships|checkin-code|progress|attendance)(?:\/|$))|invoices(?:\/|$)|payment-methods(?:\/|$)|waivers(?:\/|$)|household(?:\/|$)|context$|households(?:\/current)?$|claims\/complete$|invitations\/accept$)|links\/(?:pay-invoice|update-card|sign-waiver|onboarding)(?:\/|$)|members(?:\/|$)|households(?:\/|$)|member-tags(?:\/|$)|staff\/(profiles|roles|invitations|users)|programs(?:\/|$)|rank-systems(?:\/|$)|ranks(?:\/|$)|promotions(?:\/|$)|content-packs(?:\/|$)|schedule(?:\/|$)|attendance(?:\/|$)|imports(?:\/|$)|exports(?:\/|$)|kiosk(?:\/|$)|settings\/integrations(?:\/|$))/.test(path)
  || path === '/api/portal/credits'
  || path === '/api/announcements' || path.startsWith('/api/announcements/')
  || path === '/api/health/auto-update'
  || path.startsWith('/api/reports/')
  || path === '/api/billing/discounts' || path.startsWith('/api/billing/discounts/')
  || path === '/api/billing/class-packs' || path.startsWith('/api/billing/class-packs/')
  || path.startsWith('/api/billing/packs/')
  || /^\/api\/billing\/memberships\/\{membershipId\}\/switch(?:\/|$)/.test(path)
  || path === '/api/billing/memberships/{membershipId}/discount'
  || path === '/api/billing/credits/adjust' || /^\/api\/billing\/members\/[^/]+\/credits$/.test(path)
  || path === '/api/leads' || path.startsWith('/api/leads/')
  || ['/api/links/unsubscribe', '/api/waivers/template-documents', '/api/waivers/templates/{templateId}/document', '/api/waivers/template-document',
    '/api/portal/waiver-templates/{templateId}/document', '/api/public/waivers/{templateId}/document', '/l/{token}/documents/{templateId}',
    '/api/dashboard', '/api/health/charge-failures', '/api/health/charge-failures/dismiss', '/api/settings/go-live', '/api/setup/finish', '/staff-invitation',
    '/api/account', '/api/account/email', '/api/account/email/confirm', '/account-email'].includes(path)
  || /^\/(?:csp-report|api\/public\/(?:config|waivers|trial|drop-in|plans|join)|drop-in\/signatures|public\/pages\/(?:client\.js|styles\.css|theme\.css|logo\/\{version\})|(?:trial|drop-in)(?:\/received)?|l\/(?:\{token\}|client\.js|styles\.css|cleared|return)|join(?:\/(?:signatures|checkout|return|cancelled|sign-in|portal-login|client\.js))?)$/.test(path);
const key = (entry: Pick<Entry, 'method' | 'path'>) => `${entry.method} ${entry.path}`;
// Each intake form and its API route share ten attempts per gym/IP per fifteen minutes, before validation.
// The sweep deliberately exhausts that production budget across roles; only these public
// intake operations may answer 429. Never broaden this allowance to protected routes.
// The CSP report endpoint answers 204 to every request, valid or not; no other route may.
const noContent = new Set(['POST /csp-report']);
const budgetedPublicIntake = new Set(['POST /api/public/trial', 'POST /api/public/drop-in', 'POST /trial', 'POST /drop-in',
  'POST /api/public/join', 'POST /join']);

// The signed-link Checkout return finds its link from the receipt cookie the link's page set; without one it is unavailable.
const receiptReturn = 'GET /l/return';
// This public capability requires a valid signed query token, not a session.
const documentCapability = 'GET /api/waivers/template-document';
// Public portal routes that act for the signed-in user (choosing a household, completing a claim): anonymous callers get 401.
// The account routes act for the signed-in login too: its own account and sign-in email change.
const signedInPublic = new Set(['GET /api/portal/households', 'POST /api/portal/households/current', 'POST /api/portal/claims/complete',
  'GET /api/account', 'POST /api/account/email']);

test('the running route inventory matches the reviewed authorization sweep', async ({ install }, info) => {
  const actual = Object.entries(install.document.paths).flatMap(([path, methods]) =>
    inScope(path) ? Object.entries(methods).filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
      .map(([method, operation]) => ({ method: method.toUpperCase(), path, permission: operation.permission,
        ...(operation.additionalPermissions ? { additionalPermissions: operation.additionalPermissions } : {}) })) : []);
  await info.attach('running-routes', { body: JSON.stringify(actual, null, 2), contentType: 'application/json' });
  expect(actual.map(key).sort()).toEqual(inventory.map(key).sort());
  for (const entry of inventory) {
    expect(actual.find((item) => key(item) === key(entry)), key(entry)).toEqual(entry);
    for (const permission of [entry.permission, ...(entry.additionalPermissions ?? [])])
      if (permission.kind === 'staff') expect(Object.hasOwn(matrix, permission.capability!), key(entry)).toBe(true);
  }
});

test('every route enforces all staff roles, anonymous access and device boundaries', async ({ install }, info) => {
  test.setTimeout(300_000);
  const probes: { role: Role | 'anonymous' | 'device'; client: Client }[] = [
    ...all.map((role) => ({ role, client: install.clients[role] })),
    { role: 'anonymous', client: new Client(gymOrigin) }, { role: 'device', client: install.device },
  ];
  const results: { route: string; role: string; status: number }[] = [];
  for (const { role, client } of probes) for (const entry of inventory) {
    const operation = install.document.paths[entry.path][entry.method.toLowerCase()];
    const url = new URL(entry.path.replace(/\{[^}]+\}/g, missingId), gymOrigin);
    for (const parameter of operation.parameters ?? [])
      if (parameter.in === 'query' && parameter.required) url.searchParams.set(parameter.name, 'invalid');
    const upload = entry.path === '/api/imports/uploads';
    const response = await client.request(url.pathname + url.search, entry.method,
      upload ? Buffer.from('--qa-boundary--\r\n') : entry.method === 'GET' ? undefined : 'invalid',
      upload ? { 'content-type': 'multipart/form-data; boundary=qa-boundary' } : {});
    results.push({ route: key(entry), role, status: response.status });
    const detail = `${key(entry)} as ${role}: ${response.status} ${response.text}`;
    const permissions = [entry.permission, ...(entry.additionalPermissions ?? [])];
    const allowed = permissions.every((permission) => permission.kind === 'public'
      || (permission.kind === 'staff' && all.includes(role as Role) && matrix[permission.capability!].includes(role as Role))
      || (permission.kind === 'kiosk' && role === 'device'));
    if (response.status === 429 && entry.permission.kind === 'public' && budgetedPublicIntake.has(key(entry))) continue;
    // A device token is accepted on check-in endpoints only: tenant routes, public ones included, answer it with
    // 404. Public install routes (the content-pack catalog, setup, demo) run before tenancy and answer it like anyone.
    if (role === 'device' && entry.permission.kind === 'public') expect([200, ...noContent.has(key(entry)) ? [204] : [], 400, 404, 409], detail).toContain(response.status);
    // Their handlers refuse anonymous callers, after validation rejects the sweep's invalid bodies.
    else if (role === 'anonymous' && signedInPublic.has(key(entry))) expect(entry.method === 'GET' ? [401] : [400, 401], detail).toContain(response.status);
    else if (role === 'device' && entry.permission.kind !== 'kiosk') expect(response.status, detail).toBe(404);
    // A missing ID makes 404 the right answer only where the path has one; on a collection route a 404 is a
    // missing mount or a wrong denial, never an allowed response.
    else if (allowed) expect(/\{[^}]+\}/.test(entry.path) || [receiptReturn, documentCapability].includes(key(entry)) ? [200, 400, 404, 409]
      : [200, ...noContent.has(key(entry)) ? [204] : [], 400, 409], detail).toContain(response.status);
    else if (entry.permission.kind === 'member') expect(response.status, detail).toBe(404);
    // Only a link's own bearer token opens a signed-link route; sessions and missing tokens are unauthenticated.
    else if (entry.permission.kind === 'signed_link') expect(response.status, detail).toBe(401);
    else expect(response.status, detail).toBe(role === 'anonymous' ? 401 : 403);
  }
  await info.attach('authorization-results', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
});

test('discount catalog is mounted for managers and isolates gyms through production routes', async ({ install, sandboxes }) => {
  const path = '/api/billing/discounts';
  for (const role of ['owner', 'admin'] as const) {
    const client = install.clients[role];
    const created = await client.json<{ data: { id: string; revision: number; uses: number; planIds: string[] } }>(path, 'POST', {
      name: 'Catalog ' + role, code: 'CATALOG-' + role, currency: 'USD', percentBasisPoints: 1500, duration: 'cycles', cycles: 3,
    });
    expect(created.data).toMatchObject({ revision: 1, uses: 0, planIds: [] });
    const item = path + '/' + created.data.id;
    expect((await client.request(item)).status).toBe(200);
    expect((await client.request(item, 'PATCH', { revision: 1, active: false })).status).toBe(200);
    expect((await client.request(item, 'PATCH', { revision: 1, active: true })).status).toBe(409);
    expect((await client.request(path, 'POST', { name: 'catalog ' + role, currency: 'USD', waivesSignupFee: true })).status).toBe(409);
    for (const denied of ['coach', 'front_desk'] as const) {
      expect((await install.clients[denied].request(item)).status).toBe(403);
      expect((await install.clients[denied].request(item, 'PATCH', { revision: 2, name: 'Denied' })).status).toBe(403);
    }
  }
  const own = await demoClient(sandboxes[0], 'owner'), other = await demoClient(sandboxes[1], 'owner');
  const foreign = (await other.json<{ data: { id: string } }>(path, 'POST', {
    name: 'Other gym discount', currency: 'USD', waivesSignupFee: true,
  })).data;
  expect((await own.request(path + '/' + foreign.id)).status).toBe(404);
  expect((await own.request(path + '/' + foreign.id, 'PATCH', { revision: 1, active: false })).status).toBe(404);
  const list = await own.json<{ data: { id: string }[] }>(path);
  expect(list.data.some(row => row.id === foreign.id)).toBe(false);
  const plan = (await other.json<{ data: { id: string } }>('/api/billing/plans', 'POST', {
    name: 'Other gym discount plan', currency: 'USD', amountCents: 1000, interval: 'monthly',
  })).data;
  expect((await own.request(path, 'POST', { name: 'Foreign plan attempt', currency: 'USD', waivesSignupFee: true, planIds: [plan.id] })).status).toBe(404);
});

test('lead funnel allows owners, admins and front desk, and denies coaches', async ({ install }) => {
  const path = '/api/leads/funnel?from=2026-01-01&to=2026-12-31';
  for (const role of ['owner', 'admin', 'front_desk'] as const) {
    const response = await install.clients[role].request(path);
    expect(response.status, response.text).toBe(200);
    expect(response.body).toMatchObject({ data: { from: '2026-01-01', to: '2026-12-31', sources: expect.any(Array) } });
  }
  expect((await install.clients.coach.request(path)).status).toBe(403);
});

test('lead edits, loss, reopening and erasure work through the production routes', async ({ install }) => {
  const owner = install.clients.owner;
  for (const role of ['owner', 'admin', 'front_desk'] as const) {
    const client = install.clients[role];
    const home = (await owner.json<{ data: { id: string } }>('/api/households', 'POST', { name: 'Lead payer ' + role })).data;
    const member = (await owner.json<{ data: { id: string; revision: number } }>('/api/members', 'POST', {
      householdId: home.id, firstName: 'Lead' + role, lastName: 'Lifecycle', status: 'prospect',
    })).data;
    const path = '/api/leads/' + member.id;
    expect((await client.json<{ data: { revision: number } }>(path)).data.revision).toBe(0);
    for (const [method, suffix, body] of [
      ['GET', '', undefined], ['PATCH', '', { revision: 0, source: 'phone' }],
      ['POST', '/lost', { revision: 0, reason: 'Private' }], ['POST', '/reopen', { revision: 0 }],
    ] as const) expect((await install.clients.coach.request(path + suffix, method, body)).status).toBe(403);
    const edited = await client.json<{ data: { revision: number; stage: string } }>(path, 'PATCH', {
      revision: 0, source: 'phone', stage: 'trial_booked', nextFollowUpOn: '2026-11-10',
    });
    expect(edited.data).toMatchObject({ revision: 1, stage: 'trial_booked' });
    expect((await client.request(path, 'PATCH', { revision: 0, stage: 'contacted' })).status).toBe(409);
    expect((await client.request(path, 'PATCH', { revision: 1, stage: 'won' })).status).toBe(409);
    expect((await client.request(path + '/lost', 'POST', { revision: 1, reason: 'Private reason' })).status).toBe(200);
    const query = '?search=Lead' + role;
    expect((await client.json<{ data: unknown[] }>('/api/leads' + query)).data).toEqual([]);
    const listed = await client.json<{ data: { memberId: string }[]; counts: { lost: number } }>('/api/leads' + query + '&includeLost=true');
    expect(listed.data.map(row => row.memberId)).toEqual([member.id]); expect(listed.counts.lost).toBe(1);
    const reopened = await client.json<{ data: { stage: string; lostReason: string | null } }>(path + '/reopen', 'POST', { revision: 2 });
    expect(reopened.data).toMatchObject({ stage: 'contacted', lostReason: null });
    expect((await owner.request('/api/members/' + member.id + '/anonymize', 'POST', { revision: member.revision })).status).toBe(200);
    expect((await client.request(path)).status).toBe(404);
    expect((await client.json<{ data: unknown[] }>('/api/leads' + query + '&includeLost=true')).data).toEqual([]);
  }
});

test('lead contacts are logged and read by owners, admins and front desk, refused to coaches, and gone after erasure', async ({ install }) => {
  const owner = install.clients.owner;
  for (const role of ['owner', 'admin', 'front_desk'] as const) {
    const client = install.clients[role];
    const home = (await owner.json<{ data: { id: string } }>('/api/households', 'POST', { name: 'Contact payer ' + role })).data;
    const member = (await owner.json<{ data: { id: string; revision: number } }>('/api/members', 'POST', {
      householdId: home.id, firstName: 'Contact' + role, lastName: 'Log', status: 'prospect',
    })).data;
    const path = '/api/leads/' + member.id + '/contacts';
    expect((await install.clients.coach.request(path)).status).toBe(403);
    expect((await install.clients.coach.request(path, 'POST', { revision: 0, channel: 'call' })).status).toBe(403);
    const logged = await client.json<{ data: { lead: { stage: string; revision: number; nextFollowUpOn: string | null }; contact: { id: string; note: string } } }>(
      path, 'POST', { revision: 0, channel: 'call', note: 'Private contact note', nextFollowUpOn: '2026-11-12' });
    expect(logged.data.lead).toMatchObject({ stage: 'contacted', revision: 1, nextFollowUpOn: '2026-11-12' });
    expect((await client.request(path, 'POST', { revision: 0, channel: 'text' })).status).toBe(409);
    const listed = await client.json<{ data: { id: string; note: string }[]; pagination: { total: number } }>(path);
    expect(listed.data.map(row => row.id)).toEqual([logged.data.contact.id]); expect(listed.pagination.total).toBe(1);
    expect((await owner.request('/api/members/' + member.id + '/anonymize', 'POST', { revision: member.revision })).status).toBe(200);
    expect((await client.request(path)).status).toBe(404);
  }
});

test('members reports require reports and billing access with monthly answers', async ({ install }) => {
  const path = '/api/reports/members?from=2026-01&to=2026-01';
  for (const role of all) {
    const response = await install.clients[role].request(path);
    expect(response.status, role).toBe(managers.includes(role) ? 200 : 403);
    if (managers.includes(role)) {
      const { data } = JSON.parse(response.text);
      expect(data.buckets).toHaveLength(1);
      for (const b of data.buckets) expect(b.activeAtStart + b.new + b.imported - b.cancelled).toBe(b.activeAtEnd);
    }
  }
});

test('automatic updates are owner-only and unavailable on multi-gym installs', async ({ install, sandboxes }) => {
  const path = '/api/health/auto-update';
  const read = await install.clients.owner.json<{ data: { available: boolean; enabled: boolean; revision: number } }>(path);
  expect(read.data.available).toBe(true);
  expect((await install.clients.owner.request(path, 'PUT', { enabled: read.data.enabled, revision: read.data.revision })).status).toBe(200);
  for (const role of ['admin', 'coach', 'front_desk'] as const) {
    expect((await install.clients[role].request(path)).status).toBe(403);
    expect((await install.clients[role].request(path, 'PUT', { enabled: false, revision: read.data.revision })).status).toBe(403);
  }
  const owner = await demoClient(sandboxes[0], 'owner');
  const multi = await owner.json<{ data: { available: boolean; revision: number } }>(path);
  expect(multi.data.available).toBe(false);
  expect((await owner.request(path, 'PUT', { enabled: false, revision: multi.data.revision })).status).toBe(409);
  const other = new Client(sandboxes[1].origin);
  other.cookie = owner.cookie;
  expect([401, 403]).toContain((await other.request(path)).status);
  expect([401, 403]).toContain((await other.request(path, 'PUT', { enabled: false, revision: multi.data.revision })).status);
});

test('revenue report is mounted and restricted by reports.revenue', async ({ install, sandboxes }) => {
  const path = '/api/reports/revenue?from=2026-01&to=2026-01';
  for (const role of all) {
    const response = await install.clients[role].request(path);
    expect(response.status, role).toBe(managers.includes(role) ? 200 : 403);
    if (managers.includes(role)) {
      expect(JSON.parse(response.text).data).toMatchObject({ from: '2026-01', to: '2026-01', currencies: expect.any(Array) });
    }
  }
  const owner = await demoClient(sandboxes[0], 'owner');
  expect((await owner.request(path)).status).toBe(200);
  const foreign = new Client(sandboxes[1].origin);
  foreign.cookie = owner.cookie;
  expect([401, 403]).toContain((await foreign.request(path)).status);
});

for (const width of [360, 1280]) test('report tabs retain their program and recent queries at ' + width, async ({ page, sandboxes }, info) => {
  const sandbox = sandboxes[0], owner = await demoClient(sandbox, 'owner');
  await owner.browser(page.context());
  await page.setViewportSize({ width, height: 900 });
  const requests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/reports/')) requests.push(new URL(request.url()).pathname);
  });
  await page.goto(sandbox.origin + '/admin/reports');
  await page.getByRole('table').waitFor();
  const program = page.getByLabel('Program', { exact: true });
  const selected = await program.locator('option').nth(1).getAttribute('value');
  expect(selected).toBeTruthy();
  await program.selectOption(selected!);
  for (const name of ['Members', 'Revenue', 'Attendance']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await page.getByRole('table').first().waitFor();
    await accessibleLayout(page, info, 'reports-' + name.toLowerCase() + '-' + width);
    const path = info.outputPath('reports-' + name.toLowerCase() + '-' + width + '.png');
    await page.screenshot({ path, fullPage: true });
    await info.attach(name + '-' + width, { path, contentType: 'image/png' });
  }
  await expect(program).toHaveValue(selected!);
  expect(requests.filter(path => path.endsWith('/attendance'))).toHaveLength(1);
});

test('a household login cannot reach staff routes', async ({ sandboxes }) => {
  const member = await demoClient(sandboxes[0], 'student');
  for (const entry of inventory.filter((item) => item.permission.kind === 'staff' && item.path !== '/api/setup/finish')) {
    const path = entry.path.replace(/\{[^}]+\}/g, missingId);
    const response = await member.request(path, entry.method, entry.method === 'GET' ? undefined : 'invalid');
    expect([401, 403], `${key(entry)}: ${response.text}`).toContain(response.status);
  }
  const bootstrap = await member.json<{ data: { session: { roles: string[]; member: boolean } } }>('/api/auth/bootstrap');
  expect(bootstrap.data.session).toMatchObject({ roles: [], member: true });
});

// The demo has no Stripe account, so starting card setup is unavailable there; nothing else may answer 503.
const stripeCheckout = new Set(['POST /api/portal/payment-methods/checkout']);

for (const width of [360, 1280]) test('coach undoes a credit check-in from the session roster at ' + width + 'px', async ({ install, sandboxes, page, context }, info) => {
  const owner = install.clients.owner, coach = install.clients.coach, name = 'Undo visit ' + width;
  const home = (await owner.json<{ data: { id: string } }>('/api/households', 'POST', { name })).data;
  const member = (await owner.json<{ data: { id: string } }>('/api/members', 'POST',
    { firstName: 'Undo' + width, lastName: 'Credit', householdId: home.id })).data;
  await owner.json('/api/billing/credits/adjust', 'POST', { memberId: member.id, credits: 1,
    reason: 'Roster undo check', adjustmentId: crypto.randomUUID() });
  const began = Date.now() - 5 * 60_000;
  const session = (await owner.json<{ data: { id: string } }>('/api/schedule/sessions', 'POST', {
    name, startsAt: new Date(began).toISOString(), endsAt: new Date(began + 60 * 60_000).toISOString(),
    coachId: null, capacity: null, notes: null, kind: 'class', programIds: [install.program.id], tagIds: [],
  })).data;
  const visit = (await coach.json<{ data: { id: string } }>('/api/attendance', 'POST',
    { memberId: member.id, sessionId: session.id, programId: null })).data;
  const read = '/api/billing/members/' + member.id + '/credits', undo = '/api/attendance/' + visit.id + '/undo';
  expect((await owner.json<{ data: { balance: number } }>(read)).data.balance).toBe(0);
  expect((await new Client(gymOrigin).request(undo, 'POST')).status).toBe(401);
  expect((await install.device.request(undo, 'POST')).status).toBe(404);
  const foreign = await demoClient(sandboxes[0], 'owner');
  expect((await foreign.request(undo, 'POST')).status).toBe(404);
  await coach.browser(context); await page.setViewportSize({ width, height: 900 });
  await page.goto(gymOrigin + '/admin/schedule');
  await showWeek(page, await gymTimezone(owner), began);
  await page.getByRole('button', { name: new RegExp(name) }).click();
  const roster = page.getByRole('region', { name: 'Coach check-in roster', exact: true });
  await roster.getByLabel('Member name').fill('Undo' + width);
  await roster.getByRole('button', { name: 'Search members', exact: true }).click();
  const action = roster.getByRole('button', { name: 'Undo check-in for Undo' + width + ' Credit', exact: true });
  await expect(action).toBeVisible();
  await action.scrollIntoViewIfNeeded();
  const target = await action.boundingBox(); expect(target!.height).toBeGreaterThanOrEqual(44); expect(target!.width).toBeGreaterThanOrEqual(44);
  expect(target!.y).toBeGreaterThanOrEqual(0); expect(target!.y + target!.height).toBeLessThanOrEqual(900);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('undo-roster-' + width + '.png'), fullPage: true });
  await action.click();
  const confirm = page.getByRole('dialog', { name: 'Undo check-in', exact: true });
  await expect(confirm).toContainText('Any class credit spent on it returns to its original pack.');
  const submit = confirm.getByRole('button', { name: 'Undo check-in', exact: true });
  const button = await submit.boundingBox(); expect(button!.height).toBeGreaterThanOrEqual(44); expect(button!.width).toBeGreaterThanOrEqual(44);
  expect(button!.x).toBeGreaterThanOrEqual(0); expect(button!.x + button!.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('undo-confirm-' + width + '.png'), fullPage: true });
  await submit.click();
  await expect(roster.getByRole('button', { name: 'Check in Undo' + width + ' Credit', exact: true })).toBeEnabled();
  expect((await owner.json<{ data: { balance: number } }>(read)).data.balance).toBe(1);
  expect((await coach.request(undo, 'POST')).status).toBe(404);
  await page.reload(); await showWeek(page, await gymTimezone(owner), began);
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await roster.getByLabel('Member name').fill('Undo' + width);
  await roster.getByRole('button', { name: 'Search members', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check in Undo' + width + ' Credit', exact: true })).toBeEnabled();
});
test('front desk reads and adjusts credits with replay protection; coaches and foreign gyms are refused', async ({ install, sandboxes }) => {
  const owner = install.clients.owner, desk = install.clients.front_desk;
  const home = (await owner.json<{ data: { id: string } }>('/api/households', 'POST', { name: 'Credit adjustment payer' })).data;
  const member = (await owner.json<{ data: { id: string } }>('/api/members', 'POST',
    { firstName: 'Credit', lastName: 'Holder', householdId: home.id })).data;
  const read = '/api/billing/members/' + member.id + '/credits', write = '/api/billing/credits/adjust';
  const body = { memberId: member.id, credits: 2, reason: 'Staff corrected count', adjustmentId: crypto.randomUUID() };
  expect((await install.clients.coach.request(read)).status).toBe(403);
  expect((await install.clients.coach.request(write, 'POST', body)).status).toBe(403);
  const first = await desk.json<{ data: { balance: number; entries: { id: string }[] } }>(write, 'POST', body);
  expect(first.data.balance).toBe(2);
  expect(await desk.json(write, 'POST', body)).toEqual(first);
  const balance = await desk.json<{ data: { balance: number; entries: unknown[] } }>(read);
  expect(balance.data.balance).toBe(2);
  expect(balance.data.entries).toHaveLength(1);
  expect((await desk.request(write, 'POST', { ...body, reason: '', adjustmentId: crypto.randomUUID() })).status).toBe(400);
  const low = await desk.request(write, 'POST', { ...body, credits: -3, adjustmentId: crypto.randomUUID() });
  expect(low.status).toBe(409);
  expect(JSON.parse(low.text)).toMatchObject({ error: { details: { reason: ['insufficient_credits'] } } });
  const foreign = await demoClient(sandboxes[0], 'owner');
  expect((await foreign.request(read)).status).toBe(404);
  expect((await foreign.request(write, 'POST', body)).status).toBe(404);
  const foreignMembers = await foreign.json<{ data: { id: string }[] }>('/api/members');
  expect((await desk.request(write, 'POST', { ...body, memberId: foreignMembers.data[0]!.id, adjustmentId: crypto.randomUUID() })).status).toBe(404);
  expect((await desk.request('/api/billing/members/' + foreignMembers.data[0]!.id + '/credits')).status).toBe(404);
});

test('front desk reads and sells a pack for the member household; coach and foreign members are refused', async ({ install, sandboxes }) => {
  const owner = install.clients.owner, desk = install.clients.front_desk;
  const home = (await owner.json<{ data: { id: string } }>('/api/households', 'POST', { name: 'Pack sale payer' })).data;
  const member = (await owner.json<{ data: { id: string } }>('/api/members', 'POST',
    { firstName: 'Pack', lastName: 'Buyer', householdId: home.id })).data;
  const pack = (await owner.json<{ data: { id: string; revision: number } }>('/api/billing/class-packs', 'POST',
    { name: 'Sale test classes', currency: 'USD', amountCents: 10000, credits: 10 })).data;
  expect((await desk.request('/api/billing/class-packs')).status).toBe(200);
  expect((await desk.request('/api/billing/class-packs/' + pack.id)).status).toBe(200);
  const path = '/api/billing/packs/' + pack.id + '/sell', body = { memberId: member.id, dueOn: '2026-11-10' };
  expect((await install.clients.coach.request(path, 'POST', body)).status).toBe(403);
  const invoice = (await desk.json<{ data: { householdId: string; amountCents: number; status: string } }>(path, 'POST', body)).data;
  expect(invoice).toMatchObject({ householdId: home.id, amountCents: 10000, status: 'open' });
  expect((await desk.request(path, 'POST', { ...body, householdId: missingId })).status).toBe(400);
  const foreign = await demoClient(sandboxes[0], 'owner');
  const members = await foreign.json<{ data: { id: string }[] }>('/api/members');
  expect((await desk.request(path, 'POST', { ...body, memberId: members.data[0]!.id })).status).toBe(404);
  expect((await foreign.request(path, 'POST', { ...body, memberId: members.data[0]!.id })).status).toBe(404);
  await owner.json('/api/billing/class-packs/' + pack.id, 'PATCH', { revision: pack.revision, active: false });
  expect((await desk.request(path, 'POST', body)).status).toBe(409);
});

for (const width of [360, 1280]) test('pack-only tax archive confirms its affected packs at ' + width + 'px', async ({ install, page, context }, info) => {
  const owner = install.clients.owner, name = 'Pack tax ' + width;
  const tax = (await owner.json<{ data: { id: string } }>('/api/billing/tax-rates', 'POST',
    { name, rateMillionths: 50000, inclusive: false })).data;
  const pack = (await owner.json<{ data: { id: string; revision: number } }>('/api/billing/class-packs', 'POST',
    { name: 'Ten classes ' + width, currency: 'USD', amountCents: 10000, credits: 10, taxRateIds: [tax.id] })).data;
  const archivedName = 'Archived classes ' + width;
  await owner.json('/api/billing/class-packs', 'POST',
    { name: archivedName, currency: 'USD', amountCents: 10000, credits: 10, active: false, taxRateIds: [tax.id] });
  expect((await install.clients.coach.request('/api/billing/class-packs/' + pack.id)).status).toBe(403);
  expect((await install.clients.admin.request('/api/billing/class-packs/' + pack.id)).status).toBe(200);
  const stale = await owner.request('/api/billing/class-packs/' + pack.id, 'PATCH', { revision: pack.revision + 1, active: false });
  expect(stale.status).toBe(409);
  await owner.browser(context);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(gymOrigin + '/admin/billing/plans');
  await page.getByRole('button', { name: 'Tax rates', exact: true }).click();
  await page.getByRole('button', { name: 'Edit ' + name, exact: true }).click();
  await page.getByLabel('Active', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Archive ' + name + '?' });
  await expect(panel.getByRole('heading', { name: 'Class packs' })).toBeVisible();
  await expect(panel.getByText('These catalog items still carry this tax rate. Archiving it removes it from all of them.')).toBeVisible();
  await expect(panel.getByText('Ten classes ' + width, { exact: true })).toBeVisible();
  await expect(panel.getByText(archivedName + ' (Inactive)', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const screenshot = info.outputPath('pack-tax-' + width + '.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach('pack-tax-' + width, { path: screenshot, contentType: 'image/png' });
  await panel.getByRole('button', { name: 'Remove and archive — items: 2', exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect((await owner.json<{ data: { taxRateIds: string[] } }>('/api/billing/class-packs/' + pack.id)).data.taxRateIds).toEqual([]);
});

for (const width of [360, 1280]) test('portal class credits respect payer and adult scope at ' + width + 'px', async ({ sandboxes, page, context }, info) => {
  test.setTimeout(180_000);
  const sandbox = sandboxes[0]!, owner = await demoClient(sandbox, 'owner');
  const suffix = crypto.randomUUID(), payerEmail = `credit-payer-${suffix}@example.test`, adultEmail = `credit-adult-${suffix}@example.test`;
  const home = (await owner.json<{ data: { id: string } }>('/api/households', 'POST', { name: 'Credit household ' + width, email: payerEmail })).data;
  const create = async (firstName: string) => (await owner.json<{ data: { id: string } }>('/api/members', 'POST',
    { householdId: home.id, firstName, lastName: 'Credit reader', dateOfBirth: '1990-01-01', status: 'active' })).data;
  const adult = await create('Alex'), sibling = await create('Kim');
  const pack = (await owner.json<{ data: { id: string } }>('/api/billing/class-packs', 'POST',
    { name: 'Portal classes ' + width, currency: 'USD', amountCents: 0, credits: 10, expiryDays: 30 })).data;
  await owner.json('/api/billing/packs/' + pack.id + '/sell', 'POST', { memberId: adult.id, dueOn: '2026-11-11' });
  for (const [memberId, credits] of [[adult.id, 2], [sibling.id, 3]] as const)
    await owner.json('/api/billing/credits/adjust', 'POST', { memberId, credits, reason: 'Class count', adjustmentId: crypto.randomUUID() });
  // Payment effects run in the durable worker after the zero invoice settles.
  await expect.poll(async () => (await owner.json<{ data: { balance: number } }>('/api/billing/members/' + adult.id + '/credits')).data.balance,
    { timeout: 30_000 }).toBe(12);
  const login = async (scope: 'payer' | 'member', email: string, memberId?: string) => {
    const invitation = await owner.json<{ data: { invitationUrl: string } }>(`/api/households/${home.id}/portal-invitations`, 'POST',
      { email, delivery: 'print', scope, ...(memberId ? { memberId } : {}) });
    const before = await outboxIds(owner);
    await new Client(sandbox.origin).json('/api/portal/invitations/accept', 'POST', { token: new URL(invitation.data.invitationUrl).hash.slice(1) });
    return claimPortal(sandbox.origin, await outboxLink(owner, email, /^\/api\/auth\//, before));
  };
  const payer = await login('payer', payerEmail), member = await login('member', adultEmail, adult.id);
  type Balance = { memberId: string; firstName: string; lastName: string; balance: number; soonestExpiry: string | null };
  const payerRead = await payer.json<{ data: Balance[]; householdId: string }>('/api/portal/credits');
  expect(payerRead.householdId).toBe(home.id);
  expect(payerRead.data.map(row => [row.memberId, row.balance])).toEqual([[adult.id, 12], [sibling.id, 3]]);
  expect(payerRead.data[0]!.soonestExpiry).not.toBeNull();
  const own = await member.json<{ data: Balance[] }>('/api/portal/credits');
  expect(own.data).toEqual([payerRead.data[0]]);
  expect(Object.keys(own.data[0]!).sort()).toEqual(['balance', 'firstName', 'lastName', 'memberId', 'soonestExpiry']);
  expect((await member.request('/api/portal/invoices')).status).toBe(404);
  const foreign = new Client(sandboxes[1]!.origin); foreign.cookie = member.cookie;
  expect([403, 404]).toContain((await foreign.request('/api/portal/credits')).status);
  const student = await demoClient(sandbox, 'student');
  const other = await student.json<{ data: Balance[] }>('/api/portal/credits');
  expect(other.data.some(row => [adult.id, sibling.id].includes(row.memberId))).toBe(false);
  await page.setViewportSize({ width, height: 900 });
  await payer.browser(context);
  await page.goto(sandbox.origin + '/portal/billing');
  await expect(page.getByText('12 classes left', { exact: true })).toBeVisible();
  await expect(page.getByText('3 classes left', { exact: true })).toBeVisible();
  const bootstrap = await payer.json<{ data: { gym: { timezone: string } } }>('/api/auth/bootstrap');
  const date = await page.evaluate(({ expiry, timezone }) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: timezone }).format(new Date(expiry)),
    { expiry: own.data[0]!.soonestExpiry!, timezone: bootstrap.data.gym.timezone });
  await expect(page.getByText('Expires on ' + date, { exact: true })).toBeVisible();
  await accessibleLayout(page, info, 'payer-credits-' + width);
  await page.screenshot({ path: info.outputPath('payer-credits-' + width + '.png'), fullPage: true });
  await context.clearCookies(); await member.browser(context);
  await page.goto(sandbox.origin + '/portal/billing');
  await expect(page.getByText('12 classes left', { exact: true })).toBeVisible();
  await expect(page.getByText('Kim Credit reader', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Invoices', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Saved cards', exact: true })).toHaveCount(0);
  await accessibleLayout(page, info, 'adult-credits-' + width);
  await page.screenshot({ path: info.outputPath('adult-credits-' + width + '.png'), fullPage: true });
  await owner.json('/api/billing/credits/adjust', 'POST', { memberId: adult.id, credits: -12, reason: 'Classes used', adjustmentId: crypto.randomUUID() });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();
  await expect.poll(async () => (await member.json<{ data: Balance[] }>('/api/portal/credits')).data.length).toBe(0);
  await expect(page.getByText('No class credits', { exact: true })).toBeVisible();
});

test('a payer household login reaches every portal route', async ({ sandboxes }) => {
  // The demo student is its household's payer, so payer-only routes must answer too.
  const member = await demoClient(sandboxes[0], 'student');
  member.headers['X-Portal-Household'] = (await member.json<{ householdId: string }>('/api/portal/context')).householdId;
  for (const entry of inventory.filter(item => item.permission.kind === 'member')) {
    const response = await member.request(entry.path.replace(/\{[^}]+\}/g, missingId), entry.method,
      entry.method === 'GET' ? undefined : 'invalid');
    const reached = /\{[^}]+\}/.test(entry.path) ? [200, 400, 403, 404] : [200, 400];
    expect(stripeCheckout.has(key(entry)) ? [...reached, 503] : reached, `${key(entry)}: ${response.text}`).toContain(response.status);
  }
});
