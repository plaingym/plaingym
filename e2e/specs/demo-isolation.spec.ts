// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, Client, demoClient, type Person, type Program, type Rank, type RecordId } from '../support.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('local demo has lived-in data and working owner and coach logins', async ({ page, sandboxes }) => {
  const sandbox = sandboxes[0], owner = new Client(sandbox.origin);
  await page.goto(sandbox.origin + '/admin');
  await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Sign in as owner', exact: true }).click()]);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  owner.cookie = (await page.context().cookies(sandbox.origin)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const dashboard = await owner.json<{ data: { widgets: { id: string; count: number; status: string }[] } }>('/api/dashboard');
  for (const id of ['active_members', 'not_seen', 'promotion_ready'])
    expect(dashboard.data.widgets.find((widget) => widget.id === id)).toMatchObject({ status: 'ready', count: expect.any(Number) });
  expect(dashboard.data.widgets.find((widget) => widget.id === 'promotion_ready')!.count).toBeGreaterThan(0);
  const members = await owner.json<{ data: Person[] }>('/api/members?limit=100');
  expect(members.data.length).toBeGreaterThanOrEqual(22);
  expect((await owner.json<{ data: unknown[] }>('/api/staff/profiles')).data).toHaveLength(4);
  expect((await owner.json<{ data: unknown[] }>('/api/schedule/templates')).data.length).toBeGreaterThanOrEqual(15);
  await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Sign in as coach', exact: true }).click()]);
  await page.goto(sandbox.origin + '/admin/schedule');
  await expect(page.getByRole('heading', { name: 'Schedule', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /scheduled|cancelled/i }).first()).toBeVisible();
  const coach = new Client(sandbox.origin);
  coach.cookie = (await page.context().cookies(sandbox.origin)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  expect((await coach.request('/api/settings/go-live')).status).toBe(403);
  expect((await coach.request('/api/staff/profiles')).status).toBe(403);
  const upload = await owner.request(`/api/members/${members.data[0].id}/photo`, 'POST',
    { revision: members.data[0].revision, base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9V8AAAAASUVORK5CYII=', contentType: 'image/png' });
  expect(upload.status).toBe(403);
  await owner.json('/api/staff/invitations', 'POST', { email: 'outbox-only@example.invalid', role: 'coach', delivery: 'email' });
  const outbox = await owner.json<{ data: { recipient: string }[] }>('/api/demo/outbox');
  expect(outbox.data).toEqual(expect.arrayContaining([expect.objectContaining({ recipient: 'outbox-only@example.invalid' })]));
  expect((await owner.request('/api/setup')).status).toBe(404);
  expect((await owner.request('/api/auth/sign-in/email', 'POST', { email: 'nobody@example.invalid', password: 'unused-password' })).status).toBe(404);
});

test('foreign resource IDs, sessions, device tokens and household PINs stay isolated', async ({ sandboxes }) => {
  const [a, b] = sandboxes, clientA = await demoClient(a, 'owner'), clientB = await demoClient(b, 'owner');
  const foreign = (await clientB.json<{ data: Person[] }>('/api/members?limit=100')).data.find((member) => member.firstName === 'Marcus')!;
  const home = (await clientB.json<{ data: RecordId }>('/api/households/' + foreign.householdId)).data;
  const profile = (await clientB.json<{ data: RecordId[] }>('/api/staff/profiles')).data[0];
  const role = (await clientB.json<{ data: RecordId[] }>('/api/staff/roles')).data[0];
  const memberTag = (await clientB.json<{ data: RecordId[] }>('/api/member-tags')).data[0];
  const program = (await clientB.json<{ data: Program[] }>('/api/programs')).data.find((item) => item.rankSystemId)!;
  const rank = (await clientB.json<{ data: Rank[] }>('/api/ranks?rankSystemId=' + program.rankSystemId)).data[0];
  const template = (await clientB.json<{ data: (RecordId & { programIds: string[] })[] }>('/api/schedule/templates')).data[0];
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString(), until = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const session = (await clientB.json<{ data: (RecordId & { startsAt: string; endsAt: string })[] }>(`/api/schedule/sessions?from=${from}&until=${until}&limit=100`)).data[0];
  const paths = [
    `/api/members/${foreign.id}`, `/api/members/${foreign.id}/medical-notes`, `/api/members/${foreign.id}/photo`,
    `/api/members/${foreign.id}/tags`, `/api/households/${home.id}`, `/api/households/${home.id}/billing-settings`,
    `/api/staff/profiles/${profile.id}`, `/api/staff/profiles/${profile.id}/photo`,
    `/api/schedule/templates/${template.id}`, `/api/schedule/sessions/${session.id}`,
    `/api/kiosk/standing/${foreign.id}`, `/api/attendance/totals?memberId=${foreign.id}`,
    `/api/attendance?memberId=${foreign.id}`, `/api/promotions?memberId=${foreign.id}`,
    `/api/promotions/eligibility?programId=${program.id}&rankId=${rank.id}`,
  ];
  for (const path of paths) {
    const response = await clientA.request(path);
    expect(response.status, `${path}: ${response.text}`).toBe(404);
  }
  const changes: [string, string, unknown][] = [
    ['PATCH', `/api/members/${foreign.id}`, { revision: foreign.revision, firstName: 'Leaked' }],
    ['POST', `/api/members/${foreign.id}/anonymize`, { revision: foreign.revision }],
    ['PATCH', `/api/members/${foreign.id}/medical-notes`, { revision: foreign.revision, medicalNotes: 'Leaked' }],
    ['PATCH', `/api/households/${home.id}`, { revision: home.revision, name: 'Leaked' }],
    ['PUT', `/api/households/${home.id}/pin`, { revision: home.revision, pin: '9999' }],
    ['DELETE', `/api/households/${home.id}`, { revision: home.revision }],
    ['PATCH', `/api/member-tags/${memberTag.id}`, { revision: memberTag.revision, name: 'Leaked' }],
    ['DELETE', `/api/member-tags/${memberTag.id}`, { revision: memberTag.revision }],
    ['PATCH', `/api/staff/profiles/${profile.id}`, { revision: profile.revision, displayName: 'Leaked' }],
    ['PATCH', `/api/staff/roles/${role.id}`, { revision: role.revision, role: 'coach' }],
    ['DELETE', `/api/staff/roles/${role.id}`, { revision: role.revision }],
    ['PATCH', `/api/programs/${program.id}`, { revision: program.revision, name: 'Leaked' }],
    ['PATCH', `/api/rank-systems/${program.rankSystemId}`, { revision: 1, name: 'Leaked' }],
    ['PATCH', `/api/ranks/${rank.id}`, { revision: rank.revision, name: 'Leaked' }],
    ['POST', `/api/schedule/sessions/${session.id}/cancel`, { revision: session.revision }],
    ['PATCH', `/api/schedule/sessions/${session.id}/notes`, { revision: session.revision, notes: 'Leaked' }],
    ['PATCH', `/api/schedule/sessions/${session.id}/capacity`, { revision: session.revision, capacity: 5 }],
    ['POST', '/api/attendance', { memberId: foreign.id, sessionId: null, programId: null }],
    ['POST', '/api/members', { householdId: home.id, firstName: 'Leaked', lastName: 'Person' }],
    ['POST', '/api/promotions', { memberId: foreign.id, programId: program.id, rankId: rank.id,
      rankSystemId: program.rankSystemId, subRank: 0, promotedAt: new Date().toISOString() }],
  ];
  for (const [method, path, body] of changes) {
    const response = await clientA.request(path, method, body);
    expect(response.status, `${method} ${path}: ${response.text}`).toBe(404);
  }
  const copiedSession = new Client(b.origin);
  copiedSession.cookie = clientA.cookie;
  expect((await copiedSession.request('/api/members')).status).toBe(403);
  const copiedDevice = new Client(b.origin, { authorization: 'Bearer ' + a.kioskToken });
  expect((await copiedDevice.request('/api/kiosk/lookup', 'POST', { name: 'Marcus Rivera', pin: '2468' })).status).toBe(404);
  const deviceA = new Client(a.origin, { authorization: 'Bearer ' + a.kioskToken });
  const forged = await deviceA.json<{ data: { status: string }[] }>('/api/kiosk/checkin', 'POST',
    { name: 'Marcus Rivera', pin: '2468', checkins: [{ memberId: foreign.id, sessionId: null }] });
  expect(forged.data).toEqual([{ status: 'see_front_desk' }]);
  const own = (await clientA.json<{ data: Person[] }>('/api/members?search=Marcus')).data[0];
  const wrongFamily = (await clientA.json<{ data: Person[] }>('/api/members?search=Daniel')).data[0];
  await clientA.json('/api/households/' + own.householdId + '/pin', 'PUT', {
    revision: (await clientA.json<{ data: RecordId }>('/api/households/' + own.householdId)).data.revision, pin: '1357' });
  const forgedFamily = await deviceA.json<{ data: { status: string }[] }>('/api/kiosk/checkin', 'POST',
    { name: 'Marcus Rivera', pin: '1357', checkins: [{ memberId: wrongFamily.id, sessionId: null }] });
  expect(forgedFamily.data).toEqual([{ status: 'see_front_desk' }]);
  const unchanged = await clientB.json<{ data: Person }>('/api/members/' + foreign.id);
  expect(unchanged.data.firstName).toBe('Marcus');
  expect((await clientB.json<{ data: RecordId }>('/api/schedule/sessions/' + session.id)).data.revision).toBe(session.revision);
});

test('a moved generated session keeps its attendance after materialization runs again', async ({ sandboxes }) => {
  const sandbox = sandboxes[1], owner = await demoClient(sandbox, 'owner');
  interface Session extends RecordId {
    templateId: string; name: string; startsAt: string; endsAt: string; coachId: string | null;
    capacity: number | null; notes: string | null; kind: string; programIds: string[]; tagIds: string[];
  }
  const from = new Date().toISOString(), until = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const session = (await owner.json<{ data: Session[] }>(`/api/schedule/sessions?from=${from}&until=${until}&status=scheduled&limit=100`)).data.find((item) => item.templateId)!;
  expect(session).toBeDefined();
  const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: 'Session move family' })).data;
  const member = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id, firstName: 'Move', lastName: 'Student' })).data;
  const attendance = (await owner.json<{ data: RecordId }>('/api/attendance', 'POST', { memberId: member.id, sessionId: session.id, programId: null })).data;
  const fields = { name: session.name, startsAt: new Date(Date.parse(session.startsAt) + 600_000).toISOString(),
    endsAt: new Date(Date.parse(session.endsAt) + 600_000).toISOString(), coachId: session.coachId,
    capacity: session.capacity, notes: session.notes, kind: session.kind, programIds: session.programIds, tagIds: session.tagIds, revision: session.revision };
  const moved = (await owner.json<{ data: Session }>('/api/schedule/sessions/' + session.id, 'PUT', fields)).data;
  expect(moved.id).toBe(session.id);
  expect((await owner.request('/api/schedule/sessions/' + session.id, 'PUT', fields)).status).toBe(409);
  // The supported seed CLI invokes the same materializer as the scheduled job.
  await promisify(execFile)('docker', ['compose', '--project-name', process.env.E2E_COMPOSE_PROJECT!, '--file', 'compose.yaml',
    'exec', '-T', 'demo', 'gym-app', 'seed', sandbox.gymId], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, timeout: 60_000,
  });
  const rows = (await owner.json<{ data: Session[] }>(`/api/schedule/sessions?from=${from}&until=${until}&limit=100`)).data;
  expect(rows.filter((item) => item.templateId === session.templateId && item.startsAt === session.startsAt)).toHaveLength(0);
  expect(rows.find((item) => item.id === session.id)).toMatchObject({ startsAt: moved.startsAt, revision: moved.revision });
  const history = await owner.json<{ data: RecordId[] }>('/api/attendance?memberId=' + member.id);
  expect(history.data.map((item) => item.id)).toEqual([attendance.id]);
});
