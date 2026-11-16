// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createDemoRoutes } from './demo.routes.js';
import type { DemoService } from './service.js';
import type { RequestEnvironment } from '../core/context.js';
import type { PermissionMiddleware } from '../core/registry.js';
import { mountSourceLink } from '../core/source-link.js';
import { demoLandingPage, repositoryUrl } from './landing.page.js';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import screenshots from './screenshots.json' with { type: 'json' };

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
  expect(response.headers.get('content-security-policy')?.split(';').map(part => part.trim()).filter(part => !part.startsWith('report-'))).toEqual([
    "default-src 'none'", "script-src 'none'", "style-src 'self'", "img-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ]);
  const html = await response.text();
  const links = [...html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(match => [match[1], match[2]]);
  expect(links).toEqual(expect.arrayContaining([
    ['https://showcase.demo.example.test/demo', 'Try the demo'], ['https://github.com/plaingym/plaingym', 'GitHub'],
    ['https://showcase.demo.example.test/demo', 'Try the demo'], ['https://github.com/plaingym/plaingym', 'GitHub'],
    ['/source', 'Source code'],
  ]));
  expect(html).not.toMatch(/<script|\sstyle\s*=/i);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  for (const [, url] of html.matchAll(/(?:href|src)="(https?:[^"]+)"/g)) {
    expect(['https://showcase.demo.example.test', 'https://github.com']).toContain(new URL(url!).origin);
  }
  for (const [svg] of html.matchAll(/<svg\b[^>]*>/g)) expect(svg).toContain('aria-hidden="true"');
});
it('has ten linked feature sections, responsive screenshots and native lightboxes with fallbacks', () => {
  const html = demoLandingPage('/demo', source);
  for (const key of Object.keys(screenshots)) {
    expect(html).toContain(`href="#feature-${key}"`);
    expect(html).toContain(`id="feature-${key}"`);
    expect(html).toContain(`aria-labelledby="${key}-heading"`);
    expect(html).toContain(`popovertarget="shot-${key}"`);
    expect(html).toMatch(new RegExp(`id="shot-${key}"[^>]*popover="auto"`));
    expect(html).toMatch(new RegExp(`popovertarget="shot-${key}"[^>]*popovertargetaction="hide"`));
    expect(html).toContain(`href="/demo-assets/${screenshots[key as keyof typeof screenshots].light[1]}"`);
  }
  for (const [img] of html.matchAll(/<img\b[^>]*>/g)) {
    expect(img).toMatch(/alt="[^"]+"/); expect(img).toMatch(/width="\d+"/); expect(img).toMatch(/height="\d+"/);
    expect(img).toContain('loading="lazy"'); expect(img).toContain('srcset='); expect(img).toContain('sizes=');
  }
  expect(html).toContain('prefers-color-scheme: dark');
  expect(Buffer.byteLength(html)).toBeLessThan(100_000);
});
it('serves only the manifest assets on the entry host with immutable image caching', async () => {
  const app = appFor(true);
  const files = Object.values(screenshots).flatMap(shot => [...shot.light, ...shot.dark]);
  expect(files).toHaveLength(40);
  for (const file of files) {
    expect(file).toMatch(/-[a-f0-9]{16}\.webp$/);
    const path = new URL('./screenshots/' + file, import.meta.url);
    expect((await stat(path)).size).toBeLessThan(200_000);
    expect(file).toContain(createHash('sha256').update(await readFile(path)).digest('hex').slice(0, 16));
    const response = await app.request(origin + '/demo-assets/' + file);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(path));
  }
  const asset = '/demo-assets/' + files[0];
  expect((await app.request('https://showcase.demo.example.test' + asset)).status).toBe(404);
  expect((await appFor(false).request(origin + asset)).status).toBe(404);
  expect((await app.request(origin + '/demo-assets/not-an-image.webp')).status).toBe(404);
  expect((await app.request(origin + '/demo-assets/%2e%2e%2fpackage.json')).status).toBe(404);
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
