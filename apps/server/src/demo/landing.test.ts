// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { html as htmlTemplate } from 'hono/html';
import { createDemoRoutes } from './demo.routes.js';
import type { DemoService } from './service.js';
import type { RequestEnvironment } from '../core/context.js';
import type { PermissionMiddleware } from '../core/registry.js';
import { mountSourceLink } from '../core/source-link.js';
import { setLogSink } from '../core/log.js';
import { demoLandingPage, featureKeys } from './landing.page.js';
import { createLandingAssets, readLandingAsset } from './landing.assets.js';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import screenshots from './screenshots.json' with { type: 'json' };
import messages from '../../../../locales/en/demo/product.json' with { type: 'json' };

const origin = 'https://demo.example.test';
const source = 'https://github.com/plaingym/plaingym/tree/v1.2.3';
const showcase = 'https://showcase.demo.example.test/demo#kioskToken=device';
const cssFile = new URL('./screenshots/landing.css', import.meta.url);
const stylesheetName = (css: Buffer) => `landing-${createHash('sha256').update(css).digest('hex').slice(0, 16)}.css`;
function appFor(enabled: boolean, { sourceUrl = source, ready = true, mountSource = true, readAsset }: {
  sourceUrl?: string; ready?: boolean; mountSource?: boolean;
  readAsset?: NonNullable<Parameters<typeof createDemoRoutes>[1]['readAsset']>;
} = {}) {
  const app = new OpenAPIHono<RequestEnvironment>();
  const authorize: PermissionMiddleware = permission => async (_c, next) => {
    expect(permission.kind).toBe('public'); await next();
  };
  // Landing mounts only use the pool's showcase discovery.
  const service = new Proxy({} as DemoService, { get: () => { throw new Error('Unexpected demo service access'); } });
  const pool = { showcase: async () => ready ? showcase : undefined } as NonNullable<Parameters<typeof createDemoRoutes>[1]['pool']>;
  if (mountSource) mountSourceLink(app, sourceUrl, authorize);
  for (const route of createDemoRoutes(service, { installOrigin: origin, enabled, sourceUrl, pool, ...(readAsset ? { readAsset } : {}) }))
    route.mount(app, authorize);
  app.get('/', c => c.text('gym root'));
  app.get('/demo', c => c.text('SPA start page'));
  return app;
}

it('serves the entry root as HTML with ordered CTAs, the showcase start URL, source link and strict CSP', async () => {
  const response = await appFor(true).request(origin + '/');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const html = await response.text();
  const scriptPath = html.match(/<script src="([^"]+)"/)?.[1];
  expect(scriptPath).toMatch(/^\/demo-assets\/landing-menu-[a-f0-9]{16}\.js$/);
  expect(response.headers.get('content-security-policy')?.split(';').map(part => part.trim()).filter(part => !part.startsWith('report-'))).toEqual([
    "default-src 'none'", `script-src ${new URL(origin).host}${scriptPath}`, "style-src 'self'", "img-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ]);
  const links = [...html.replace(/<svg\b.*?<\/svg>/g, '').replace(/<span class="shrink-0[^"]*"><\/span>/g, '')
    .matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(match => [match[1], match[2]]);
  expect(links).toEqual(expect.arrayContaining([
    [showcase, 'Try the demo'], ['https://github.com/plaingym/plaingym', 'GitHub'],
    ['/source', 'Source code'],
  ]));
  expect(html).not.toMatch(/\sstyle\s*=/i);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  for (const [, url] of html.matchAll(/(?:href|src)="(https?:[^"]+)"/g)) {
    expect(['https://showcase.demo.example.test', 'https://github.com']).toContain(new URL(url!).origin);
  }
  for (const [svg] of html.matchAll(/<svg\b[^>]*>/g)) expect(svg).toContain('aria-hidden="true"');
});
it('shows a disabled Try the demo with a startup note while the showcase is unready', async () => {
  const response = await appFor(true, { ready: false }).request(origin + '/');
  expect(response.status).toBe(200);
  const html = await response.text();
  const actions = [...html.matchAll(/<button type="button" disabled=""[^>]*>.*?<\/span>Try the demo<\/button>/g)];
  expect(actions).toHaveLength(6);
  expect(html).toContain('The demo is starting. Reload in a minute.');
  expect(html).not.toContain('href="https://showcase.');
});
it('renders without a mounted source link and uses a non-GitHub source URL as provided', async () => {
  const sourceUrl = 'https://gitlab.com/org/subgroup/repo/-/tree/release?view=files';
  const app = appFor(true, { sourceUrl, mountSource: false });
  expect((await app.request(origin + '/source')).status).toBe(404);
  const response = await app.request(origin + '/');
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toMatch(/<a href="https:\/\/gitlab\.com\/org\/subgroup\/repo\/-\/tree\/release\?view=files"[^>]*><span[^>]*>.*?<\/span>Repository<\/a>/);
  expect(html).toMatch(/<a href="\/source"[^>]*>AGPL-3\.0 license<\/a>/);
  expect(html).toMatch(/<a href="\/source"[^>]*>Self-hosting guide<\/a>/);
  expect(html).not.toContain('/blob/main/');
});
it('has ten linked feature sections, responsive screenshots and native lightboxes with fallbacks', () => {
  const html = demoLandingPage('/demo', source);
  const pictures = [...html.matchAll(/<picture>.*?<\/picture>/gs)].map(([picture]) => picture);
  for (const key of featureKeys) {
    const { light, dark, width } = screenshots[key];
    expect(html).toContain(`href="#feature-${key}"`);
    expect(html).toContain(`id="feature-${key}"`);
    expect(html).toContain(`aria-labelledby="${key}-heading"`);
    expect(html).toContain(`popovertarget="shot-${key}"`);
    expect(html).toMatch(new RegExp(`id="shot-${key}"[^>]*popover="auto"`));
    expect(html).toMatch(new RegExp(`popovertarget="shot-${key}"[^>]*popovertargetaction="hide"`));
    expect(html).toContain(`href="/demo-assets/${light[1]}"`);
    const variants = pictures.filter(picture => picture.includes(`src="/demo-assets/${light[0]}"`));
    expect(variants).toHaveLength(key === 'schedule' ? 4 : 3);
    for (const picture of variants) {
      expect(picture).toContain(`srcset="/demo-assets/${light[0]} ${width}w, /demo-assets/${light[1]} ${width * 2}w"`);
      if (dark.some((file, index) => file !== light[index])) {
        expect(picture).toContain(`media="(prefers-color-scheme: dark)" srcset="/demo-assets/${dark[0]} ${width}w, /demo-assets/${dark[1]} ${width * 2}w"`);
      } else {
        expect(picture).not.toContain('<source');
      }
    }
  }
  for (const [img] of html.matchAll(/<img\b[^>]*>/g)) {
    expect(img).toMatch(/alt="[^"]+"/); expect(img).toMatch(/width="\d+"/); expect(img).toMatch(/height="\d+"/);
    expect(img).toContain('srcset='); expect(img).toContain('sizes=');
  }
  // Only the hero screenshot loads eagerly; every other image waits until it nears the viewport.
  const loading = [...html.matchAll(/<img\b[^>]*loading="(\w+)"/g)].map(match => match[1]);
  expect(loading[0]).toBe('eager');
  expect(loading.slice(1).every(value => value === 'lazy')).toBe(true);
  expect(html.match(/fetchpriority="high"/g)).toHaveLength(1);
  // On a phone held upright an expanded screenshot keeps its own width, so its text stays readable (T1029).
  for (const key of featureKeys) {
    expect(html).toContain(`sizes="(max-width: 767px) and (orientation: portrait) ${screenshots[key].width}px, 90vw"`);
  }
  expect(html).toContain('prefers-color-scheme: dark');
  expect(html).toContain('<html lang="en" class="theme-system">');
  expect(Buffer.byteLength(html)).toBeLessThan(100_000);
});
it('uses the fallback image directly when the same files serve both themes', () => {
  const shot = screenshots.schedule;
  const dark = shot.dark;
  try {
    shot.dark = shot.light;
    const html = demoLandingPage('/demo', source);
    const pictures = [...html.matchAll(/<picture>.*?<\/picture>/gs)].map(([picture]) => picture)
      .filter(picture => picture.includes(`src="/demo-assets/${shot.light[0]}"`));
    expect(pictures).toHaveLength(4);
    for (const picture of pictures) expect(picture).not.toContain('<source');
  } finally {
    shot.dark = dark;
  }
});
it('has a header with section links, native phone menus and icons on both calls to action', async () => {
  const response = await appFor(true).request(origin + '/');
  const html = await response.text();
  // The header stays at the top on every width, and a section reached from a link stops below it.
  const header = html.match(/<header class="sticky top-0[^>]*>.*?<\/header>/s)?.[0] ?? '';
  expect(header).not.toBe('');
  const css = await readFile(cssFile);
  expect(css.toString()).toContain('scroll-padding-top: calc(5rem + env(safe-area-inset-top));');
  expect(html.indexOf(header)).toBeLessThan(html.indexOf('<main'));
  expect(header).toContain('>PlainGym</a>');
  // The desktop row and both phone menus list the same links, each a target the page defines.
  const lists = [header.match(/<nav aria-label="Main".*?<\/nav>/s)?.[0], header.match(/<div id="site-menu".*?<\/ul>/s)?.[0], header.match(/<details.*?<\/details>/s)?.[0]];
  for (const list of lists) {
    expect(list).toBeDefined();
    const text = (list ?? '').replace(/<svg\b.*?<\/svg>/g, '').replace(/<[^>]+>/g, '|').split('|').filter(Boolean);
    expect(text).toEqual(['Why PlainGym', 'Features', 'How the demo works', 'Try the demo', 'GitHub']);
    for (const [target] of [['#strengths'], ['#features'], ['#explore']] as const) {
      expect(list).toContain(`href="${target}"`);
      expect(html).toMatch(new RegExp(`<h2 id="${target.slice(1)}"`));
    }
  }
  // The button opens the native popover. Escape and outside taps close it.
  expect(header).toMatch(/<button type="button" popovertarget="site-menu"[^>]*aria-label="Menu"/);
  expect(header).toMatch(/<div id="site-menu" popover="auto"/);
  expect(header).toMatch(/<summary[^>]*aria-label="Menu"/);
  for (const panel of [/id="site-menu"[^>]*class="([^"]*)"/, /<ul class="([^"]*\bdemo-menu-fallback-panel\b[^"]*)"/]) {
    expect(header.match(panel)?.[1]?.split(' ')).toEqual(expect.arrayContaining(['overflow-y-auto', 'overscroll-contain']));
  }
  expect(css.toString()).toMatch(/\.demo-menu, \.demo-menu-fallback-panel\s*\{\s*max-height: var\(--demo-menu-max-height\);\s*\}/);
  // Both calls to action, in the hero, the explore section and the header, lead with an aria-hidden icon and keep their text.
  for (const [label, count] of [['Try the demo', 6], ['GitHub', 5]] as const) {
    const withIcon = [...html.matchAll(/<a href="[^"]+"[^>]*><span class="shrink-0[^"]*"><svg\b[^>]*aria-hidden="true"[^>]*>.*?<\/svg><\/span>([^<]+)<\/a>/g)].filter(match => match[1] === label);
    expect(withIcon.length).toBeGreaterThanOrEqual(count);
  }
  // Every menu control is a 44 px target, and the page links its own stylesheet by content hash.
  expect(header).not.toMatch(/<(?:a|button|summary)\b(?![^>]*min-h-11)[^>]*>/);
  expect(html).toContain(`<link rel="stylesheet" href="/demo-assets/${stylesheetName(css)}"/>`);
  expect(html).not.toMatch(/\sstyle\s*=|\sonclick=/i);
});
it('keeps the running version in the footer after the source, license and self-hosting links', () => {
  const html = demoLandingPage('/demo', source), footer = html.match(/<footer.*?<\/footer>/s)?.[0] ?? '';
  const text = footer.replace('<span class="sr-only">Version </span>', '').replace(/<[^>]+>/g, '|').split('|').filter(Boolean);
  expect(text.slice(0, 3)).toEqual(['Source code', 'AGPL-3.0 license', 'Self-hosting guide']);
  expect(text).toHaveLength(4);
  expect(footer).toContain('<span class="sr-only">Version </span>' + text[3]);
  expect(footer).toContain('flex-wrap');
});
it('serves only the manifest assets on the entry host with immutable image caching', async () => {
  const app = appFor(true);
  const directory = new URL('./screenshots/', import.meta.url);
  const files = [...new Set(Object.values(screenshots).flatMap(shot => [...shot.light, ...shot.dark]))];
  expect((await readdir(directory)).filter(file => file.endsWith('.webp')).sort()).toEqual([...files].sort());
  for (const key of featureKeys) {
    const { light, dark } = screenshots[key];
    expect(light).toHaveLength(2);
    expect(dark).toHaveLength(2);
    for (const density of [1, 2]) {
      const fallback = light[density - 1]!;
      const variant = dark[density - 1]!;
      expect(fallback).toMatch(new RegExp(`^${key}-light-${density}x-[a-f0-9]{16}\\.webp$`));
      if (variant !== fallback) {
        expect(variant).toMatch(new RegExp(`^${key}-dark-${density}x-[a-f0-9]{16}\\.webp$`));
        expect(await readFile(new URL(variant, directory))).not.toEqual(await readFile(new URL(fallback, directory)));
      }
    }
  }
  for (const file of files) {
    const bytes = await readFile(new URL(file, directory));
    expect(bytes.length).toBeLessThan(200_000);
    expect(file).toContain(createHash('sha256').update(bytes).digest('hex').slice(0, 16));
    const response = await app.request(origin + '/demo-assets/' + file);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  }
  const asset = '/demo-assets/' + files[0];
  expect((await app.request('https://showcase.demo.example.test' + asset)).status).toBe(404);
  expect((await appFor(false).request(origin + asset)).status).toBe(404);
  expect((await app.request(origin + '/demo-assets/not-an-image.webp')).status).toBe(404);
  expect((await app.request(origin + '/demo-assets/%2e%2e%2fpackage.json')).status).toBe(404);
});
it('names the page stylesheet by its content hash and caches it like the images', async () => {
  const css = await readFile(cssFile);
  const readAsset = vi.fn(readLandingAsset);
  const app = appFor(true, { readAsset });
  expect(readAsset).not.toHaveBeenCalled();
  const page = await app.request(origin + '/');
  const file = stylesheetName(css);
  expect(await page.text()).toContain(`href="/demo-assets/${file}"`);
  const response = await app.request(origin + '/demo-assets/' + file);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(css);
  // The unhashed name and other hashes aren't served, and the stylesheet stays off gym hosts.
  for (const file of ['landing.css', 'landing-0000000000000000.css']) expect((await app.request(origin + '/demo-assets/' + file)).status).toBe(404);
  expect((await app.request('https://showcase.demo.example.test/demo-assets/' + file)).status).toBe(404);
  expect(readAsset.mock.calls).toEqual([['landing.css'], ['landing-menu.js']]);
});
it('loads one deferred phone menu script from the entry host with immutable caching', async () => {
  const readAsset = vi.fn(readLandingAsset);
  const app = appFor(true, { readAsset });
  const page = await app.request(origin + '/');
  const scripts = [...(await page.text()).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  expect(scripts).toHaveLength(1);
  const [, attributes, inline] = scripts[0]!;
  expect(attributes).toMatch(/\bdefer(?:="")?(?:\s|$)/);
  expect(inline).toBe('');
  const path = attributes?.match(/\bsrc="([^"]+)"/)?.[1];
  const body = await readLandingAsset('landing-menu.js');
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  expect(path).toBe(`/demo-assets/landing-menu-${hash}.js`);
  const response = await app.request(origin + path);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
  expect((await app.request(origin + '/demo-assets/landing-menu-0000000000000000.js')).status).toBe(404);
  expect((await app.request(origin + '/demo-assets/landing-menu.js')).status).toBe(404);
  expect((await app.request('https://showcase.demo.example.test' + path)).status).toBe(404);
  expect((await appFor(false).request(origin + path)).status).toBe(404);
  expect(readAsset.mock.calls.filter(([file]) => file === 'landing-menu.js')).toHaveLength(1);
});
it('shares in-flight asset reads and logs a missing manifest asset once', async () => {
  const present = screenshots.members.light[0]!, missing = screenshots.members.light[1]!;
  const readAsset = vi.fn(async (file: string) => {
    if (file === missing) throw Object.assign(new Error('Missing file'), { code: 'ENOENT' });
    return Buffer.from('image');
  });
  const lines: string[] = [];
  const previous = setLogSink(line => { lines.push(line); });
  try {
    const app = appFor(true, { readAsset });
    const get = (file: string) => app.request(origin + '/demo-assets/' + file);
    const responses = await Promise.all([get(present), get(present), get(missing), get(missing)]);
    expect(responses.map(response => response.status)).toEqual([200, 200, 404, 404]);
    expect(readAsset.mock.calls).toEqual([[present], [missing]]);
    expect(responses[2]?.headers.get('cache-control')).toBeNull();
    expect(lines.map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: 'demo.asset_unavailable', asset: missing, error: expect.objectContaining({ code: 'ENOENT' }) }),
    ]);
  } finally { setLogSink(previous); }
});
it('renders the landing page and logs once when its stylesheet is missing', async () => {
  const readAsset = vi.fn(async (file: string) => {
    if (file === 'landing.css') throw Object.assign(new Error('Missing file'), { code: 'ENOENT' });
    return readLandingAsset(file);
  });
  const logs = vi.fn();
  const previous = setLogSink(logs);
  try {
    const app = appFor(true, { readAsset });
    const page = await app.request(origin + '/');
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain('href="/demo-assets/landing-');
    const file = stylesheetName(await readFile(cssFile));
    expect((await app.request(origin + '/demo-assets/' + file)).status).toBe(404);
    expect(readAsset.mock.calls).toEqual([['landing.css'], ['landing-menu.js']]);
    expect(logs).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"asset":"landing.css"'));
  } finally { setLogSink(previous); }
});
it('keeps the native menus and disallows scripts when the phone menu script is missing', async () => {
  const previous = setLogSink(vi.fn());
  try {
    const app = appFor(true, { readAsset: async file => {
      if (file === 'landing-menu.js') throw Object.assign(new Error('Missing file'), { code: 'ENOENT' });
      return readLandingAsset(file);
    } });
    const page = await app.request(origin + '/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')?.split('; ').filter(part => part.startsWith('script-src '))).toEqual(["script-src 'none'"]);
    const html = await page.text();
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toContain('id="site-menu" popover="auto"');
    expect(html).toContain('<details class="demo-menu-fallback">');
  } finally { setLogSink(previous); }
});
it('reads an asset again after a failure other than a missing file', async () => {
  const previous = setLogSink(vi.fn());
  try {
    const read = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Too many open files'), { code: 'EMFILE' }))
      .mockResolvedValue(Buffer.from('body'));
    const assets = createLandingAssets(read);
    expect(await assets.asset('landing.css')).toBeUndefined();
    expect((await assets.asset('landing.css'))?.toString()).toBe('body');
    expect(read).toHaveBeenCalledTimes(2);
    expect((await assets.asset('landing.css'))?.toString()).toBe('body');
    expect(read).toHaveBeenCalledTimes(2);
  } finally { setLogSink(previous); }
});
it('hashes the stylesheet and menu script again after a failure other than a missing file', async () => {
  const previous = setLogSink(vi.fn());
  try {
    const read = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Too many open files'), { code: 'EMFILE' }))
      .mockRejectedValueOnce(Object.assign(new Error('Too many open files'), { code: 'EMFILE' }))
      .mockResolvedValue(Buffer.from('body'));
    const assets = createLandingAssets(read);
    expect(await assets.stylesheet()).toBeUndefined();
    expect(await assets.menuScript()).toBeUndefined();
    expect((await assets.stylesheet())?.file).toMatch(/^landing-[a-f0-9]{16}\.css$/);
    expect((await assets.menuScript())?.file).toMatch(/^landing-menu-[a-f0-9]{16}\.js$/);
    expect(read).toHaveBeenCalledTimes(4);
    await assets.stylesheet(); await assets.menuScript();
    expect(read).toHaveBeenCalledTimes(4);
  } finally { setLogSink(previous); }
});
function featureBullets(html: string, key: typeof featureKeys[number]) {
  const section = html.match(new RegExp(`<section id="feature-${key}".*?</section>`, 's'))?.[0] ?? '';
  return [...section.matchAll(/<li>([^<]+)<\/li>/g)].map(match => match[1]);
}
it('lists each feature\'s bullets from the locale file, in order', () => {
  const html = demoLandingPage('/demo', source);
  for (const key of featureKeys) {
    const items = featureBullets(html, key);
    expect(items.length).toBeGreaterThanOrEqual(3);
    const expected = Object.entries(messages).filter(([name]) => name.startsWith(key + 'Bullet'))
      .map(([, text]) => String(htmlTemplate`${text}`));
    expect(items).toEqual(expected);
  }
});
it('translates and orders the feature bullets from the supplied catalogue', () => {
  const catalog = { 'demo/product': { membersBullet10: 'Dixième', membersBullet2: 'Deuxième' } };
  const html = demoLandingPage('/demo', source, { catalog });
  const defaultPage = demoLandingPage('/demo', source);
  expect(featureBullets(html, 'members')).toEqual(['Deuxième', 'Dixième']);
  for (const key of featureKeys.filter(key => key !== 'members')) {
    const englishBullets = featureBullets(defaultPage, key);
    expect(englishBullets.length).toBeGreaterThan(0);
    expect(featureBullets(html, key)).toEqual(englishBullets);
  }
  expect(demoLandingPage('/demo', source, { catalog: { 'demo/product': messages } })).toBe(defaultPage);
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
it('uses a GitHub fork repository root without losing its release source link', async () => {
  const custom = 'https://github.com/example/gym/tree/custom?view=1#file';
  const html = demoLandingPage('https://showcase.example.test/demo#kioskToken=public-device', custom, { catalog: { 'demo/product': { pitch: '<pitch>' } } });
  expect(html).toContain('href="https://showcase.example.test/demo#kioskToken=public-device"');
  expect(html).toContain('href="https://github.com/example/gym"');
  expect(html).toContain('&lt;pitch&gt;');
  expect(html).not.toContain('<pitch>');
});
