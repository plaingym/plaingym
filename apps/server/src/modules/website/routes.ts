// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AppError, createTranslator, type RoutePermission, type Translator } from '@plaingym/shared';
import { websiteContracts } from '@plaingym/shared/contracts';
import type { RequestEnvironment } from '../../core/context.js';
import { route, type RouteRegistration } from '../../core/registry.js';
import { cspNonce, setPolicy } from '../../core/csp.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { createWebsiteService, type SitePart, type WebsiteOptions, type WebsiteService } from './service.js';
import { pagePath, renderSitePage, sitePages, siteThemeCss, siteThemeVersion, type SitePage } from './site.page.js';
import { coachParamsSchema, photoParamsSchema, removeLogoRequestSchema, updateWebsiteRequestSchema, uploadLogoRequestSchema,
  uploadPhotoRequestSchema, websiteSettingsResponseSchema } from './content.js';
import messages from '../../../../../locales/en/website/site.json' with { type: 'json' };

type Ctx = Context<RequestEnvironment>;
export interface WebsiteRouteOptions {
  readonly service: WebsiteService;
  /** The gym's canonical origin (the runtime's `originFor`); defaults to the request's own origin. */
  readonly origin?: (context: Ctx) => string;
  readonly t?: Translator;
}
const translator = createTranslator({ 'website/site': messages });
let configured: WebsiteRouteOptions | undefined;
/** The runtime supplies gym uploads and the canonical origin; until then the module's routes fail closed. */
export function configureWebsite(options: WebsiteOptions & { origin?: WebsiteRouteOptions['origin']; t?: Translator }) {
  const { origin, t, ...service } = options;
  configured = { service: createWebsiteService(service), ...(origin ? { origin } : {}), ...(t ? { t } : {}) };
  return configured.service;
}

/** The pages run no script: the one inline element, the structured-data block, carries the response's nonce. */
const siteDirectives = (nonce: string) => [`default-src 'none'`, `script-src 'nonce-${nonce}'`, `style-src 'self'`, `img-src 'self'`,
  `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`];
const parts: Record<SitePage, readonly SitePart[]> = {
  home: ['programs'], programs: ['programs', 'classes'], schedule: ['programs', 'classes', 'sessions'], plans: ['plans'], coaches: ['coaches'], contact: [],
};
const publicAccess: RoutePermission = { kind: 'public' };
const tooLarge = bodyLimit({ maxSize: 720_000, onError: () => { throw new AppError('invalid_request', 'Request too large'); } });
const settingsResponses = { 200: { description: 'Website settings', content: { 'application/json': { schema: websiteSettingsResponseSchema } } } };
const json = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { 'application/json': { schema } } } });

function staff(c: Ctx): MutationContext {
  const { principal, gym } = c.get('context');
  if (principal.kind !== 'staff' || principal.gymId !== gym.gymId) throw new AppError('not_found', 'Gym not found');
  return { gymId: gym.gymId, actor: { kind: 'user', userId: principal.userId } };
}
const image = (c: Ctx, file: { stream: ReadableStream | Uint8Array; contentType: string }) => {
  // Public, but a removed photo should not linger in caches for long.
  c.header('Cache-Control', 'public, max-age=3600'); c.header('X-Content-Type-Options', 'nosniff'); c.header('Content-Type', file.contentType);
  return c.body(file.stream as ReadableStream);
};

export function createWebsiteRoutes(supplied?: WebsiteRouteOptions): readonly RouteRegistration[] {
  const options = () => supplied ?? configured ?? (() => { throw new AppError('unavailable', 'The website is not configured'); })();
  const originOf = (c: Ctx) => (options().origin ?? ((context: Ctx) => new URL(context.req.url).origin))(c);
  const settingsData = async (c: Ctx, data: Promise<z.infer<typeof websiteSettingsResponseSchema>['data']>) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ data: await data }, 200);
  };
  return [
    ...sitePages.map((page) => route({ method: 'get', path: pagePath(page), permission: publicAccess,
      responses: { 200: { description: `Website ${page} page` } } }, async (c) => {
      const config = options(), gym = c.get('context').gym, nonce = cspNonce(c);
      const site = await config.service.site(gym.gymId, parts[page]);
      setPolicy(c, siteDirectives(nonce));
      c.header('Cache-Control', 'no-cache'); c.header('X-Content-Type-Options', 'nosniff'); c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
      return c.html(renderSitePage({ page, site, t: config.t ?? translator, origin: originOf(c), nonce }), 200);
    })),
    route({ method: 'get', path: '/website/theme.css', permission: publicAccess, responses: { 200: { description: 'Website colors' } } }, async (c) => {
      const site = await options().service.site(c.get('context').gym.gymId);
      // Only the content hash names these exact colors; missing or stale versions revalidate.
      c.header('Content-Type', 'text/css; charset=utf-8'); c.header('X-Content-Type-Options', 'nosniff');
      c.header('Cache-Control', c.req.query('v') === siteThemeVersion(site.gym.primaryColor, site.content.accentColor) ? 'public, max-age=31536000, immutable' : 'no-cache');
      return c.body(siteThemeCss(site.gym.primaryColor, site.content.accentColor));
    }),
    route({ method: 'get', path: '/website/photos/{photoId}', permission: publicAccess, request: { params: photoParamsSchema },
      responses: { 200: { description: 'Website photo' } } }, async (c) =>
      image(c, await options().service.photo(c.get('context').gym.gymId, c.req.valid('param').photoId))),
    route({ method: 'get', path: '/website/coaches/{staffProfileId}/photo', permission: publicAccess, request: { params: coachParamsSchema },
      responses: { 200: { description: 'A public coach profile photo' } } }, async (c) =>
      image(c, await options().service.coachPhoto(c.get('context').gym.gymId, c.req.valid('param').staffProfileId))),
    route({ method: 'get', path: '/sitemap.xml', permission: publicAccess, responses: { 200: { description: 'Website sitemap' } } }, async (c) => {
      const site = await options().service.site(c.get('context').gym.gymId), origin = originOf(c), modified = site.gym.updatedAt.slice(0, 10);
      const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      c.header('Content-Type', 'application/xml; charset=utf-8'); c.header('Cache-Control', 'no-cache');
      return c.body('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + sitePages.map((page) => `<url><loc>${escape(origin + pagePath(page))}</loc><lastmod>${modified}</lastmod></url>\n`).join('') + '</urlset>\n');
    }),
    route({ method: 'get', path: '/robots.txt', permission: publicAccess, responses: { 200: { description: 'Crawler rules' } } }, (c) => {
      c.header('Content-Type', 'text/plain; charset=utf-8'); c.header('Cache-Control', 'no-cache');
      return c.body(['User-agent: *', ...['/admin', '/portal', '/kiosk', '/api/', '/l/', '/login', '/setup'].map((path) => 'Disallow: ' + path),
        'Allow: /', '', 'Sitemap: ' + originOf(c) + '/sitemap.xml', ''].join('\n'));
    }),
    route({ ...websiteContracts.get, responses: settingsResponses }, async (c) => {
      staff(c); return settingsData(c, options().service.settings(c.get('context').gym.gymId));
    }),
    route({ ...websiteContracts.update, request: json(updateWebsiteRequestSchema), responses: settingsResponses }, async (c) =>
      settingsData(c, options().service.update(staff(c), c.req.valid('json')))),
    route({ ...websiteContracts.uploadPhoto, middleware: tooLarge, request: json(uploadPhotoRequestSchema), responses: settingsResponses },
      async (c) => settingsData(c, options().service.uploadPhoto(staff(c), c.req.valid('json')))),
    route({ ...websiteContracts.uploadLogo, middleware: tooLarge, request: json(uploadLogoRequestSchema), responses: settingsResponses },
      async (c) => settingsData(c, options().service.uploadLogo(staff(c), c.req.valid('json')))),
    route({ ...websiteContracts.removeLogo, request: json(removeLogoRequestSchema), responses: settingsResponses },
      async (c) => settingsData(c, options().service.removeLogo(staff(c), c.req.valid('json')))),
  ];
}
export const routes = createWebsiteRoutes();
