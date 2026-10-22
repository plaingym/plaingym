// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono, z } from '@hono/zod-openapi';
import { canStaff, isRoutePermission, staffRoles } from '@plaingym/shared';
import { membersContracts } from '@plaingym/shared/contracts';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { createServerRegistry, route, type PermissionMiddleware } from './registry.js';
import type { RequestEnvironment } from './context.js';
import { TestClock } from './clock.js';
import { FakeJobs } from '../infra/jobs/index.js';
import { areaContributions } from './registry-areas.js';
import { generateApiSource } from '../../../../scripts/generate-api.mjs';

const fixture = () =>
  route(
    {
      method: 'get',
      path: '/members/{id}',
      permission: { kind: 'staff', capability: 'members.read' },
      request: { params: z.object({ id: z.string().min(3) }) },
      responses: {
        200: {
          description: 'Member',
          content: { 'application/json': { schema: z.object({ id: z.string() }) } },
        },
      },
    },
    (context) => context.json({ id: context.req.valid('param').id }, 200),
  );
const allow: PermissionMiddleware = () => async (_context, next) => {
  await next();
};

describe('route declarations and server composition', () => {
  it.each(staffRoles)('enforces every medical-note permission before validation for %s', async (role) => {
    const contract = membersContracts.updateMedicalNotes;
    let handled = 0;
    const entry = route({
      method: contract.method, path: contract.path, permission: contract.permission,
      additionalPermissions: contract.additionalPermissions,
      request: { params: contract.params, body: { content: { 'application/json': { schema: contract.body } }, required: true } },
      responses: { 200: { description: 'Saved', content: { 'application/json': { schema: z.object({ saved: z.boolean() }) } } } },
    }, (context) => { handled++; return context.json({ saved: true }, 200); });
    const app = new OpenAPIHono<RequestEnvironment>();
    createServerRegistry({ routes: [entry] }).mount(app, permission => async (context, next) => {
      if (permission.kind !== 'staff' || !canStaff([role], permission.capability)) return context.json({ error: 'denied' }, 403);
      await next();
    }, new Set());
    const url = '/api/members/019a08bf-1234-7000-8000-000000000001/medical-notes';
    const allowed = role === 'owner' || role === 'admin';
    const request = (body: unknown) => app.request(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await request({})).status).toBe(allowed ? 400 : 403);
    expect((await request({ revision: 1, medicalNotes: null })).status).toBe(allowed ? 200 : 403);
    expect(handled).toBe(allowed ? 1 : 0);
  });
  it('requires a permission at the type and runtime boundaries', () => {
    expect(() =>
      route(
        // @ts-expect-error Missing permissions must fail compilation and runtime validation.
        { method: 'get', path: '/invalid', responses: {} },
        () => new Response(),
      ),
    ).toThrow('permission');
  });
  it('authorizes before validation and preserves typed route responses and OpenAPI schemas', async () => {
    const app = new OpenAPIHono<RequestEnvironment>();
    const registry = createServerRegistry({ routes: [fixture()] });
    const permissions: string[] = [];
    registry.mount(
      app,
      (permission) => async (context, next) => {
        permissions.push(permission.kind);
        if (context.req.header('x-test-authorized') !== 'yes')
          return context.json({ error: 'denied' }, 403);
        await next();
      },
      new Set(),
    );
    expect((await app.request('/members/x')).status).toBe(403);
    expect(
      (await app.request('/members/x', { headers: { 'x-test-authorized': 'yes' } })).status,
    ).toBe(400);
    const response = await app.request('/members/member', {
      headers: { 'x-test-authorized': 'yes' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'member' });
    expect(permissions).toEqual(['staff', 'staff', 'staff']);
    const document = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'Fixture', version: '1' },
    });
    expect(document.paths?.['/members/{id}']?.get).toBeDefined();
    const source = await generateApiSource(document);
    expect(source).toContain('"/members/{id}"');
    expect(source).toContain('createClient<paths>');
    expect(source).toContain('id: string');
  });
  it('does not run another method permission middleware on a matching path', async () => {
    const app = new OpenAPIHono<RequestEnvironment>();
    const get = route(
      {
        method: 'get',
        path: '/same',
        permission: { kind: 'public' },
        responses: { 200: { description: 'Read' } },
      },
      () => new Response('read'),
    );
    const post = route(
      {
        method: 'post',
        path: '/same',
        permission: { kind: 'staff', capability: 'members.manage' },
        responses: { 200: { description: 'Write' } },
      },
      () => new Response('write'),
    );
    createServerRegistry({ routes: [get, post] }).mount(
      app,
      (permission) => async (context, next) => {
        if (permission.kind !== 'public') return context.json({ error: 'denied' }, 403);
        await next();
      },
      new Set(),
    );
    expect(await (await app.request('/same')).text()).toBe('read');
    expect((await app.request('/same', { method: 'POST' })).status).toBe(403);
  });
  it('resolves module routes and jobs per gym while retaining core registrations', async () => {
    const moduleRoute = route(
      {
        method: 'get',
        path: '/optional',
        permission: { kind: 'public' },
        responses: { 200: { description: 'Optional page' } },
      },
      () => new Response('optional'),
    );
    const calls: string[] = [];
    const registry = createServerRegistry({
      routes: [fixture()],
      modules: [
        {
          id: 'website',
          schemaFile: null,
          routes: [moduleRoute],
          jobs: [
            {
              id: 'website.refresh',
              handler: async (_payload, context) => {
                calls.push(context.gymId);
              },
            },
          ],
          emails: [],
          web: {},
        },
      ],
    });
    const app = new OpenAPIHono<RequestEnvironment>();
    registry.mount(
      app,
      allow,
      (context) => new Set(context.req.header('x-test-gym') === 'a' ? ['website'] : []),
    );
    expect((await app.request('/optional', { headers: { 'x-test-gym': 'a' } })).status).toBe(200);
    expect((await app.request('/optional', { headers: { 'x-test-gym': 'b' } })).status).toBe(404);
    expect((await app.request('/members/member', { headers: { 'x-test-gym': 'b' } })).status).toBe(
      200,
    );
    const worker = new FakeJobs(new TestClock('2026-01-01'));
    registry.registerJobs(
      worker,
      async (context) => new Set(context.gymId === 'a' ? ['website'] : []),
    );
    for (const gymId of ['a', 'b'])
      await worker.enqueue('website.refresh', {}, { gymId, timezone: 'UTC' });
    await worker.runNext();
    await worker.runNext();
    expect(calls).toEqual(['a']);
    const disabled = new OpenAPIHono<RequestEnvironment>();
    registry.mount(disabled, allow, new Set());
    expect((await disabled.request('/optional')).status).toBe(404);
  });
  it('rejects duplicate route and module identities', () => {
    expect(() => createServerRegistry({ routes: [fixture(), fixture()] })).toThrow('Duplicate');
    const module = { id: 'website', schemaFile: null, routes: [], jobs: [], emails: [], web: {} };
    expect(() => createServerRegistry({ modules: [module, module] })).toThrow('Duplicate');
  });
  it('composes area registrations with an explicit permission on every route', () => {
    const registry = createServerRegistry(areaContributions);
    for (const registration of registry.routes.all()) {
      expect(isRoutePermission(registration.definition.permission), registration.id).toBe(true);
    }
  });
});

describe('browser and registration boundaries', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  it('bundles the browser registries without Node APIs and rejects the Node-only transaction subpath', async () => {
    const result = await build({
      entryPoints: [root + 'apps/web/src/lib/registries.ts'],
      bundle: true,
      platform: 'browser',
      write: false,
      format: 'esm',
      logLevel: 'silent',
    });
    expect(result.outputFiles[0]?.text).not.toContain('node:async_hooks');
    await expect(
      build({
        stdin: {
          contents:
            "import { runInTransaction } from '@plaingym/shared/transaction'; console.log(runInTransaction);",
          resolveDir: root + 'apps/web',
        },
        bundle: true,
        platform: 'browser',
        write: false,
        logLevel: 'silent',
      }),
    ).rejects.toThrow('Could not resolve');
  });
  it('statically wires every route/job part into its area barrel', async () => {
    const directory = root + 'apps/server/src/areas';
    for (const area of await readdir(directory)) {
      const parts = await readdir(directory + '/' + area, { recursive: true });
      for (const kind of ['routes', 'jobs']) {
        const barrel = await readFile(directory + '/' + area + '/' + kind + '.ts', 'utf8');
        for (const part of parts.filter((part) => part.endsWith('.' + kind + '.ts'))) {
          expect(barrel, area + '/' + part).toContain(
            part.replaceAll('\\', '/').replace(/\.ts$/, '.js'),
          );
        }
      }
    }
  });
  it('does not commit generated output or import transaction context into web code', async () => {
    const ignore = await readFile(root + '.gitignore', 'utf8');
    expect(ignore).toContain('dist/');
    expect(ignore).toContain('routeTree.gen.ts');
    const files = await readdir(root + 'apps/web/src', { recursive: true });
    for (const file of files.filter((file) => /\.[jt]sx?$/.test(file))) {
      expect(await readFile(root + 'apps/web/src/' + file, 'utf8')).not.toContain(
        '@plaingym/shared/transaction',
      );
    }
  });
});
