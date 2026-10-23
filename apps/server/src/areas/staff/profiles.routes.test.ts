// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { routes } from './profiles.routes.js';
import { createServerRegistry } from '../../core/registry.js';
import { TestClock } from '../../core/clock.js';
import { errorHandler } from '../../core/errors.js';
import { authorize } from './auth.permissions.js';
import type { RequestEnvironment } from '../../core/context.js';
const gymId = '01900000-0000-7000-8000-000000000001', id = '01900000-0000-7000-8000-000000000002';
function server() {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { principal: { kind: 'staff', gymId, userId: id, roles: ['owner'] },
      gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, clock: new TestClock('2026-10-22Z'), requestId: 'unconfigured-staff' });
    await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes }).mount(app, authorize, new Set());
  return app;
}
it('registers every staff route for OpenAPI without requiring runtime dependencies', () => {
  const document = server().getOpenAPIDocument({ openapi: '3.1.0', info: { title: 'Staff', version: '1' } });
  expect(document.paths).toHaveProperty('/api/staff/invitations');
  expect(document.paths).toHaveProperty('/api/staff/invitations/accept');
  expect(document.paths).toHaveProperty('/api/staff/profiles/{staffProfileId}/photo');
  expect(document.paths).toHaveProperty('/staff-invitation');
});
it('fails closed with 503 until runtime configures all staff dependencies', async () => {
  const app = server();
  const cases: [string, string, unknown?][] = [
    ['GET', '/api/staff/profiles'], ['GET', '/api/staff/profiles/' + id], ['POST', '/api/staff/profiles', { displayName: 'Coach' }],
    ['PATCH', '/api/staff/profiles/' + id, { revision: 1, bio: 'Bio' }], ['GET', '/api/staff/roles'],
    ['POST', '/api/staff/roles', { userId: id, role: 'coach' }], ['PATCH', '/api/staff/roles/' + id, { revision: 1, role: 'coach' }],
    ['DELETE', '/api/staff/roles/' + id, { revision: 1 }], ['POST', '/api/staff/invitations', { email: 'coach@example.test', role: 'coach', delivery: 'print' }],
    ['POST', '/api/staff/invitations/accept', { token: 'ab'.repeat(32), name: 'Coach' }], ['GET', '/staff-invitation'],
    ['POST', `/api/staff/profiles/${id}/photo`, { revision: 1, contentType: 'image/jpeg', base64: '/9j/4AAB' }], ['GET', `/api/staff/profiles/${id}/photo`],
  ];
  expect(cases).toHaveLength(routes.length);
  for (const [method, path, body] of cases) {
    const response = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(response.status, `${method} ${path}`).toBe(503);
  }
});
