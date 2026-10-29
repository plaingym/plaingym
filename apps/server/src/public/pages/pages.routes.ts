// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import { AppError, createTranslator, type Translator } from '@plaingym/shared';
import { publicContracts as contracts, paginationSchema, publicTrialRequestSchema } from '@plaingym/shared/contracts';
import { route, type RouteRegistration } from '../../core/registry.js';
import { rateLimit } from '../../core/rate-limit.js';
import { cachedLinkAsset } from '../links/assets.js';
import { admissionSchema, createPublicPagesService, type PublicPagesOptions, type PublicPagesService } from './service.js';
import { intakePage, themeCss } from './page.js';
import { publicBrowserScript } from './browser.js';
import messages from '../../../../../locales/en/public/pages.json' with { type: 'json' };

const translator = createTranslator({ 'public/pages': messages });
const stylesheet = cachedLinkAsset('./public/links.css');
interface PublicRoutesOptions { service: PublicPagesService; t?: Translator; stylesheet?: () => Promise<string> }
let configured: PublicRoutesOptions | undefined;
/** Integration supplies the same waiver/upload service and gym mail used by signed links. */
export function configurePublicPages(options: PublicPagesOptions & { t?: Translator; stylesheet?: () => Promise<string> }) {
  const service = createPublicPagesService(options);
  configured = { service, ...(options.t ? { t: options.t } : {}), ...(options.stylesheet ? { stylesheet: options.stylesheet } : {}) };
  return service;
}
export function createPublicRoutes(supplied?: PublicRoutesOptions): readonly RouteRegistration[] {
  const options = () => supplied ?? configured ?? (() => { throw new AppError('unavailable', 'Public pages are not configured'); })();
  const budget = rateLimit({ limit: 10, windowMs: 15 * 60_000 });
  const admissionBudget = rateLimit({ limit: 10, windowMs: 15 * 60_000 });
  const bounded = bodyLimit({ maxSize: 1024 * 1024, onError: () => { throw new AppError('invalid_request', 'Request too large'); } });
  const json = <T extends z.ZodType>(schema: T) => ({ 200: { description: 'Public page response', content: { 'application/json': { schema } } } });
  const pages = { 200: { description: 'Public gym page' }, 400: { description: 'Please check the request' } };
  const protect = (entry: RouteRegistration): RouteRegistration => ({ ...entry, mount(app, authorize) {
    entry.mount(app, permission => async (ctx, next) => {
      ctx.header('Cache-Control', 'no-store'); ctx.header('Referrer-Policy', 'no-referrer'); ctx.header('X-Content-Type-Options', 'nosniff');
      ctx.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      return authorize(permission)(ctx, next);
    });
  } });
  const result: RouteRegistration[] = [
    route({ ...contracts.config, responses: json(contracts.config.response) }, async ctx => ctx.json(await options().service.config(ctx.get('context').gym.gymId), 200)),
    route({ ...contracts.waivers, request: { query: paginationSchema }, responses: json(contracts.waivers.response) }, async ctx =>
      ctx.json(await options().service.templates(ctx.get('context').gym.gymId, ctx.req.valid('query')), 200)),
    route({ ...contracts.trial, middleware: [budget, bounded], request: { body: { required: true, content: { 'application/json': { schema: contracts.trial.body } } } }, responses: json(contracts.trial.response) }, async ctx => {
      const context = ctx.get('context'); return ctx.json(await options().service.trial(context.gym.gymId, ctx.req.valid('json'), context.gym.timezone), 200);
    }),
    route({ ...contracts.dropIn, middleware: [budget, bounded], request: { body: { required: true, content: { 'application/json': { schema: contracts.dropIn.body } } } }, responses: json(contracts.dropIn.response) }, async ctx => {
      const context = ctx.get('context'); return ctx.json(await options().service.dropIn(context.gym.gymId, ctx.req.valid('json'), context.gym.timezone, context.clientIp ?? 'unknown'), 200);
    }),
    route({ method: 'post', path: '/drop-in/signatures', permission: { kind: 'public' }, middleware: [admissionBudget, bounded],
      request: { body: { required: true, content: { 'application/json': { schema: admissionSchema } } } },
      responses: json(z.strictObject({ data: z.array(z.strictObject({ templateId: z.uuid(), templateVersion: z.number(), signatureImageKey: z.string(), signatureImageHash: z.string() })) })) }, async ctx => {
      const context = ctx.get('context'); return ctx.json(await options().service.admit(context.gym.gymId, ctx.req.valid('json'), context.gym.timezone), 200);
    }),
    route({ method: 'get', path: '/public/pages/client.js', permission: { kind: 'public' }, responses: { 200: { description: 'Progressive form enhancement' } } }, ctx => {
      ctx.header('Content-Type', 'text/javascript; charset=utf-8'); return ctx.body(publicBrowserScript);
    }),
    route({ method: 'get', path: '/public/pages/styles.css', permission: { kind: 'public' }, responses: { 200: { description: 'Shared public styles' } } }, async ctx => {
      ctx.header('Content-Type', 'text/css; charset=utf-8'); return ctx.body(await (options().stylesheet ?? stylesheet)());
    }),
    route({ method: 'get', path: '/public/pages/theme.css', permission: { kind: 'public' }, responses: { 200: { description: 'Gym colors' } } }, async ctx => {
      ctx.header('Content-Type', 'text/css; charset=utf-8'); return ctx.body(themeCss((await options().service.config(ctx.get('context').gym.gymId)).data.gym.primaryColor));
    }),
    route({ method: 'get', path: '/public/pages/logo', permission: { kind: 'public' }, responses: { 200: { description: 'Gym logo' } } }, async ctx => {
      const logo = await options().service.logo(ctx.get('context').gym.gymId);
      ctx.header('Content-Type', logo.contentType); return ctx.body(logo.stream);
    }),
  ];
  for (const kind of ['trial', 'drop-in'] as const) {
    for (const received of [false, true]) {
      result.push(route({ method: 'get', path: '/' + kind + (received ? '/received' : ''), permission: { kind: 'public' }, responses: pages }, async ctx => {
        const context = ctx.get('context'), config = options(), data = (await config.service.config(context.gym.gymId)).data;
        let templates: Awaited<ReturnType<PublicPagesService['required']>> = [], unavailable = false;
        if (!received && kind === 'drop-in') {
          try { templates = await config.service.required(context.gym.gymId); }
          catch (error) { if (!(error instanceof AppError) || error.code !== 'unavailable') throw error; unavailable = true; }
        }
        return ctx.html(intakePage({ ...data, kind, templates, t: config.t ?? translator,
          ...(received ? { state: 'received' } : unavailable ? { state: 'unavailable' } : {}) }), 200);
      }));
    }
    // Native forms work without JavaScript; drop-ins can select a PNG instead of drawing.
    result.push(route({ method: 'post', path: '/' + kind, permission: { kind: 'public' }, middleware: [budget, bounded], responses: pages }, async ctx => {
      const context = ctx.get('context'), config = options(), fields = await ctx.req.raw.formData();
      const value = (name: string) => String(fields.get(name) ?? '');
      const input = publicTrialRequestSchema.parse({ contact: { name: value('contactName'), email: value('email'), ...(value('phone') ? { phone: value('phone') } : {}) },
        member: { firstName: value('firstName'), lastName: value('lastName'), dateOfBirth: value('dateOfBirth') }, honeypot: value('honeypot') });
      if (kind === 'trial') await config.service.trial(context.gym.gymId, input, context.gym.timezone);
      else {
        const templates = await config.service.required(context.gym.gymId);
        const signatures = await Promise.all(templates.map(async (_template, i) => {
          const file = fields.get(`waiver-${i}-image`);
          if (!(file instanceof File) || !file.size || file.size > 256 * 1024 || value(`waiver-${i}-consent`) !== 'on') throw new AppError('invalid_request', 'Signature and consent required');
          return { templateId: value(`waiver-${i}-template`), templateVersion: Number(value(`waiver-${i}-version`)), pngBase64: Buffer.from(await file.arrayBuffer()).toString('base64') };
        }));
        const images = await config.service.admit(context.gym.gymId, { ...input, signatures }, context.gym.timezone);
        await config.service.dropIn(context.gym.gymId, { ...input, waivers: images.data.map((image, i) => ({ ...image,
          signer: value(`waiver-${i}-kind`) === 'guardian' ? { kind: 'guardian', name: value(`waiver-${i}-name`), relationship: value(`waiver-${i}-relationship`) }
            : { kind: 'self', name: value(`waiver-${i}-name`) }, consent: true })) }, context.gym.timezone, context.clientIp ?? 'unknown');
      }
      return ctx.html(intakePage({ ...(await config.service.config(context.gym.gymId)).data, kind, t: config.t ?? translator, state: 'received' }), 200);
    }));
  }
  return result.map(protect);
}
export const routes = createPublicRoutes();
