// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { test, expect, Client, gymOrigin, missingId, demoClient, type Operation, type Role } from '../support.js';

interface Entry { method: string; path: string; permission: Operation['permission']; additionalPermissions?: Operation['permission'][] }
const inventory: Entry[] = JSON.parse(await readFile(new URL('../authorization-inventory.json', import.meta.url), 'utf8'));
// Reviewed against the staff matrix, independently of the application's canStaff().
const all: Role[] = ['owner', 'admin', 'coach', 'front_desk'];
const managers: Role[] = ['owner', 'admin'];
const desk: Role[] = ['owner', 'admin', 'front_desk'];
const coaches: Role[] = ['owner', 'admin', 'coach'];
const matrix: Record<string, Role[]> = {
  'members.read': all, 'members.manage': desk, 'members.anonymize': managers,
  'medical.read': coaches, 'households.manage': desk, 'billing.read': desk, 'tags.manage': desk,
  'staff.manage': managers, 'settings.manage': managers, 'promotions.manage': coaches,
  'bookings.manage': all, 'schedule.manage': coaches, 'class_notes.manage': all,
  'attendance.manage': all, 'data.export': managers, 'kiosk_devices.manage': managers,
  'go_live.manage': managers, 'integrations.manage': ['owner'], 'portal_access.manage': desk,
};
const inScope = (path: string) => /^\/api\/(bookings(?:\/|$)|portal\/(?:bookings(?:\/|$)|members\/[^/]+\/bookings(?:\/|$))|members(?:\/|$)|households(?:\/|$)|member-tags(?:\/|$)|staff\/(profiles|roles|invitations|users)|programs(?:\/|$)|rank-systems(?:\/|$)|ranks(?:\/|$)|promotions(?:\/|$)|content-packs(?:\/|$)|schedule(?:\/|$)|attendance(?:\/|$)|imports(?:\/|$)|exports(?:\/|$)|kiosk(?:\/|$))/.test(path)
  || ['/api/dashboard', '/api/settings/go-live', '/api/setup/finish', '/staff-invitation'].includes(path);
const key = (entry: Pick<Entry, 'method' | 'path'>) => `${entry.method} ${entry.path}`;

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
    // A device token is accepted on check-in endpoints only: tenant routes, public ones included, answer it with
    // 404. Public install routes (the content-pack catalog, setup, demo) run before tenancy and answer it like anyone.
    if (role === 'device' && entry.permission.kind === 'public') expect([200, 400, 404, 409], detail).toContain(response.status);
    else if (role === 'device' && entry.permission.kind !== 'kiosk') expect(response.status, detail).toBe(404);
    // A missing ID makes 404 the right answer only where the path has one; on a collection route a 404 is a
    // missing mount or a wrong denial, never an allowed response.
    else if (allowed) expect(/\{[^}]+\}/.test(entry.path) ? [200, 400, 404, 409] : [200, 400, 409], detail).toContain(response.status);
    else expect(response.status, detail).toBe(role === 'anonymous' ? 401 : 403);
  }
  await info.attach('authorization-results', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
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

test('a household login reaches the six portal booking routes', async ({ sandboxes }) => {
  const member = await demoClient(sandboxes[0], 'student');
  for (const entry of inventory.filter(item => item.permission.kind === 'member')) {
    const response = await member.request(entry.path.replace(/\{[^}]+\}/g, missingId), entry.method,
      entry.method === 'GET' ? undefined : 'invalid');
    expect(/\{[^}]+\}/.test(entry.path) ? [200, 400, 403, 404] : [200, 400], `${key(entry)}: ${response.text}`).toContain(response.status);
  }
});
