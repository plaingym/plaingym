// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { AppError, errorResponse } from '@plaingym/shared';
import { createServerRegistry } from '../../core/registry.js';
import type { RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { routes } from './gym-delete.routes.js';

const gymId = '00000000-0000-7000-8000-000000000001';
// Only demo mode configures deletion; every other install keeps the route closed.
it('fails closed for an owner until demo mode configures gym deletion', async () => {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, clock: new TestClock('2026-10-22T12:00:00Z'),
      principal: { kind: 'staff', gymId, userId: '00000000-0000-7000-8000-000000000002', roles: ['owner'] }, requestId: 'test' });
    await next();
  });
  app.onError((error, c) => c.json(errorResponse(error, 'test'), error instanceof AppError ? error.status : 500));
  createServerRegistry({ routes }).mount(app, () => async (_c, next) => { await next(); }, () => new Set());
  const response = await app.request('/api/settings/gym', { method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 1, confirmation: 'DELETE' }) });
  expect(response.status).toBe(404);
});
