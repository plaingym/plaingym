// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createDemoRoutes } from './demo.routes.js';
import type { DemoService } from './service.js';
import type { RequestEnvironment } from '../core/context.js';
import type { PermissionMiddleware } from '../core/registry.js';
import { mountSourceLink } from '../core/source-link.js';
import { demoLandingPage, repositoryUrl } from './landing.page.js';

const origin = 'https://demo.example.test';
const source = 'https://github.com/plaingym/plaingym/tree/v1.2.3';
function appFor(enabled: boolean) {
  const app = new OpenAPIHono<RequestEnvironment>();
  const authorize: PermissionMiddleware = permission => async (_c, next) => {
    expect(permission.kind).toBe('public'); await next();
  };
  // Landing mounts never read a tenant, session, or demo service.
  const service = new Proxy({} as DemoService, { get: () => { throw new Error('Unexpected demo service access'); } });
  mountSourceLink(app, source, authorize);
  for (const route of createDemoRoutes(service, { installOrigin: origin, enabled })) route.mount(app, authorize);
  app.get('/', c => c.text('gym root'));
  app.get('/demo', c => c.text('SPA start page'));
  return app;
}

it('serves the entry root as HTML with ordered CTAs, the showcase start URL, source link and strict CSP', async () => {
  const response = await appFor(true).request(origin + '/');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-security-policy')).toContain("script-src 'none'");
  expect(response.headers.get('content-security-policy')).toContain("style-src 'self'");
  const html = await response.text();
  const links = [...html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(match => [match[1], match[2]]);
  expect(links).toEqual([
    ['https://showcase.demo.example.test/demo', 'Try the demo'], ['https://github.com/plaingym/plaingym', 'GitHub'],
    ['https://showcase.demo.example.test/demo', 'Try the demo'], ['https://github.com/plaingym/plaingym', 'GitHub'],
    ['/source', 'Source code'],
  ]);
  expect(html).not.toMatch(/<script|style=|deleted|24 hours/);
});
it('redirects old entry links while preserving every gym root and start page', async () => {
  const app = appFor(true), response = await app.request(origin + '/demo');
  expect(response.status).toBe(302); expect(response.headers.get('location')).toBe('/');
  for (const host of ['showcase.demo.example.test', 'private.demo.example.test', 'gym.example.test']) {
    expect(await (await app.request(`https://${host}/`)).text()).toBe('gym root');
    expect(await (await app.request(`https://${host}/demo`)).text()).toBe('SPA start page');
  }
});
it('leaves ordinary installs untouched', async () => {
  const app = appFor(false);
  expect(await (await app.request(origin + '/')).text()).toBe('gym root');
  expect(await (await app.request(origin + '/demo')).text()).toBe('SPA start page');
});
it('uses a modified installs repository root without losing its release source link', async () => {
  const custom = 'https://github.com/example/gym/tree/custom?view=1#file';
  expect(repositoryUrl(custom)).toBe('https://github.com/example/gym');
  const html = demoLandingPage('https://showcase.example.test/demo#kioskToken=public-device', custom, key => `<${key}>`);
  expect(html).toContain('href="https://showcase.example.test/demo#kioskToken=public-device"');
  expect(html).toContain('href="https://github.com/example/gym"');
  expect(html).toContain('&lt;demo/product:pitch&gt;');
  expect(html).not.toContain('<demo/product:pitch>');
});
