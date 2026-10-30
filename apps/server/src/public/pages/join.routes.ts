// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { AppError, createTranslator, type Translator } from '@plaingym/shared';
import { idSchema, paginationSchema, publicContracts as contracts, publicSubmissionResponseSchema } from '@plaingym/shared/contracts';
import { route, type RouteRegistration } from '../../core/registry.js';
import type { RequestEnvironment } from '../../core/context.js';
import { rateLimit } from '../../core/rate-limit.js';
import { createJoinService, joinAdmissionResponseSchema, joinAdmissionSchema, joinBodyBytes, maxJoinDocuments, maxJoinMembers, type JoinOptions,
  type JoinService } from './join.service.js';
import { joinContinuations, joinCookie, joinCookieLifetimeMs, type JoinContinuations } from './join.continuation.js';
import { joinFormPage, joinPlansPage, joinStatusPage, type JoinPageState } from './join.page.js';
import { joinBrowserScript } from './join.browser.js';
import pages from '../../../../../locales/en/public/pages.json' with { type: 'json' };
import messages from '../../../../../locales/en/public/join.json' with { type: 'json' };

const translator = createTranslator({ 'public/pages': pages, 'public/join': messages });
interface JoinRouteOptions { service: JoinService; continuations: JoinContinuations; t?: Translator }
let configured: JoinRouteOptions | undefined;
/** Runtime supplies the shared waiver and signed-link Checkout services, portal invitations, accounts, payment readiness and a stable key. */
export function configureJoin(options: JoinOptions & { key: Uint8Array; t?: Translator }) {
  const service = createJoinService(options);
  configured = { service, continuations: joinContinuations(options.key), ...(options.t ? { t: options.t } : {}) };
  return service;
}
export function createJoinRoutes(supplied?: JoinRouteOptions): readonly RouteRegistration[] {
  const options = () => supplied ?? configured ?? (() => { throw new AppError('unavailable', 'Online joining is not configured'); })();
  // Limits run before validation, so bots and repeats spend their budget before any household or Checkout session exists.
  const submissions = rateLimit({ limit: 10, windowMs: 15 * 60_000 });
  const admissions = rateLimit({ limit: 10, windowMs: 15 * 60_000 });
  // Steps that reach the payment provider or send mail; the read-only pages, which refresh while confirming, have only the global limit.
  const steps = rateLimit({ limit: 30, windowMs: 15 * 60_000 });
  // Room for several chosen PNG files. The install-wide limiter in front allows the native form more, so it gets its own page.
  const bounded = bodyLimit({ maxSize: joinBodyBytes, onError: () => { throw new AppError('invalid_request', 'Request too large'); } });
  // The native form renders its own page rather than a JSON error. A browser shows a connection error instead of a
  // response sent before its upload finishes; the install-wide limiter capped the declared length, so discard the rest.
  const boundedForm = bodyLimit({ maxSize: joinBodyBytes, onError: async ctx => {
    const rest = ctx.req.raw.body;
    if (rest && !rest.locked) await rest.pipeTo(new WritableStream()).catch(() => undefined);
    return page(ctx, 'tooLarge', 413);
  } });
  const json = <T extends z.ZodType>(schema: T) => ({ 200: { description: 'Join response', content: { 'application/json': { schema } } } });
  const html = { 200: { description: 'Join page' }, 303: { description: 'Next join step' }, 400: { description: 'Please check the request' },
    413: { description: 'The form is too large' }, 503: { description: 'Online joining is not available' } };
  const protect = (entry: RouteRegistration): RouteRegistration => ({ ...entry, mount(app, authorize) {
    entry.mount(app, permission => async (ctx, next) => {
      // Join URLs carry no credential. 'same-origin' keeps the Origin header on the cookie-bearing form posts, which the
      // CSRF check requires ('no-referrer' would send Origin: null), and sends no Referer to Checkout or anywhere else.
      ctx.header('Cache-Control', 'no-store'); ctx.header('Referrer-Policy', 'same-origin'); ctx.header('X-Content-Type-Options', 'nosniff');
      ctx.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      return authorize(permission)(ctx, next);
    });
  } });
  const gymOf = (ctx: Context<RequestEnvironment>) => ctx.get('context').gym.gymId;
  async function page(ctx: Context<RequestEnvironment>, state: JoinPageState, status: 200 | 400 | 413 | 503 = 200) {
    const config = options();
    return ctx.html(joinStatusPage({ gym: await config.service.branding(gymOf(ctx)), t: config.t ?? translator, state }), status);
  }
  /** HttpOnly, Secure, SameSite=Lax (it survives the return from Checkout), signed, short-lived and scoped to /join. */
  function remember(ctx: Context<RequestEnvironment>, linkId: string) {
    const expiresAt = new Date(ctx.get('context').clock.now().getTime() + joinCookieLifetimeMs);
    setCookie(ctx, joinCookie, options().continuations.seal({ gymId: gymOf(ctx), linkId, expiresAt }),
      { httpOnly: true, secure: true, sameSite: 'Lax', path: '/join', maxAge: joinCookieLifetimeMs / 1000 });
  }
  const pending = (ctx: Context<RequestEnvironment>) => options().continuations.open(getCookie(ctx, joinCookie), ctx.get('context').clock.now(), gymOf(ctx));
  const settledOrGone = (error: unknown) => error instanceof AppError && ['conflict', 'not_found', 'forbidden'].includes(error.code);
  const signer = (value: (name: string) => string, prefix: string) => value(prefix + '-kind') === 'guardian'
    ? { kind: 'guardian' as const, name: value(prefix + '-name'), relationship: value(prefix + '-relationship') } : { kind: 'self' as const, name: value(prefix + '-name') };
  const result: RouteRegistration[] = [
    route({ ...contracts.plans, request: { query: paginationSchema }, responses: json(contracts.plans.response) }, async ctx =>
      ctx.json(await options().service.plans(gymOf(ctx), ctx.req.valid('query')), 200)),
    route({ method: 'post', path: '/join/signatures', permission: { kind: 'public' }, middleware: [admissions, bounded],
      request: { body: { required: true, content: { 'application/json': { schema: joinAdmissionSchema } } } }, responses: json(joinAdmissionResponseSchema) }, async ctx =>
      ctx.json(await options().service.admit(gymOf(ctx), ctx.req.valid('json'), ctx.get('context').gym.timezone), 200)),
    // The same response for every address; only the cookie, naming this new household's pending join, continues it.
    route({ ...contracts.join, middleware: [submissions, bounded], request: { body: { required: true, content: { 'application/json': { schema: contracts.join.body } } } },
      responses: json(contracts.join.response) }, async ctx => {
      const context = ctx.get('context');
      remember(ctx, (await options().service.join(context.gym.gymId, ctx.req.valid('json'), context.gym.timezone, context.clientIp ?? 'unknown')).linkId);
      return ctx.json(publicSubmissionResponseSchema.parse({ data: { status: 'received' } }), 200);
    }),
    route({ method: 'get', path: '/join', permission: { kind: 'public' }, request: { query: z.object({ plan: z.string().optional(), members: z.string().optional() }) },
      responses: html }, async ctx => {
      const config = options(), gymId = gymOf(ctx), query = ctx.req.valid('query');
      const common = { gym: await config.service.branding(gymId), t: config.t ?? translator };
      let templates: Awaited<ReturnType<JoinService['ready']>>;
      try { templates = await config.service.ready(gymId); }
      catch (error) { if (error instanceof AppError && error.code === 'unavailable') return ctx.html(joinPlansPage({ ...common, plans: [] }), 200); throw error; }
      if (query.plan && idSchema.safeParse(query.plan).success) {
        try {
          const plan = await config.service.joinablePlan(gymId, query.plan);
          const count = Math.min(maxJoinMembers, Math.max(1, Math.trunc(Number(query.members ?? 1)) || 1));
          return ctx.html(joinFormPage({ ...common, plan, count, templates }), 200);
        } catch (error) { if (!(error instanceof AppError && error.code === 'not_found')) throw error; }
      }
      return ctx.html(joinPlansPage({ ...common, plans: (await config.service.plans(gymId, { limit: 100, offset: 0 })).data }), 200);
    }),
    // Native multipart form: signature PNG files replace the canvases when JavaScript is unavailable.
    route({ method: 'post', path: '/join', permission: { kind: 'public' }, middleware: [submissions, boundedForm], responses: html }, async ctx => {
      const context = ctx.get('context'), service = options().service, gymId = context.gym.gymId;
      try {
        const contentType = ctx.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
        if (contentType !== 'multipart/form-data') throw new AppError('invalid_request', 'Expected a form submission');
        const fields = await ctx.req.raw.formData().catch(() => { throw new AppError('invalid_request', 'Invalid form submission'); });
        const value = (name: string) => { const field = fields.get(name); return typeof field === 'string' ? field : ''; };
        const count = Number(value('members'));
        if (!Number.isInteger(count) || count < 1 || count > maxJoinMembers) throw new AppError('invalid_request', 'Invalid member count');
        const contact = { name: value('contactName'), email: value('email'), ...(value('phone') ? { phone: value('phone') } : {}) };
        const people = Array.from({ length: count }, (_, i) => ({ firstName: value(`member-${i}-firstName`), lastName: value(`member-${i}-lastName`),
          dateOfBirth: value(`member-${i}-dateOfBirth`) }));
        const common = { planId: value('planId'), contact, honeypot: value('honeypot') };
        // The documents the page rendered; the admission checks them against the current set.
        const documents = Array.from({ length: maxJoinDocuments }, (_, j) => j).filter(j => value(`waiver-0-${j}-template`));
        const signatures = await Promise.all(people.map((_, i) => Promise.all(documents.map(async j => {
          const prefix = `waiver-${i}-${j}`, file = fields.get(prefix + '-image');
          if (!(file instanceof File) || !file.size || file.size > 256 * 1024 || value(prefix + '-consent') !== 'on') throw new AppError('invalid_request', 'Signature and consent required');
          return { templateId: value(prefix + '-template'), templateVersion: Number(value(prefix + '-version')), pngBase64: Buffer.from(await file.arrayBuffer()).toString('base64') };
        }))));
        const images = await service.admit(gymId, { ...common, members: people.map((member, i) => ({ member, signatures: signatures[i]! })) }, context.gym.timezone);
        const { linkId } = await service.join(gymId, { ...common, members: people.map((member, i) => ({ member,
          waivers: images.data[i]!.map((image, j) => ({ ...image, consent: true, signer: signer(value, `waiver-${i}-${j}`) })) })) },
        context.gym.timezone, context.clientIp ?? 'unknown');
        remember(ctx, linkId);
        return page(ctx, 'continue');
      } catch (error) {
        if (error instanceof AppError && error.code === 'unavailable') return page(ctx, 'unavailable', 503);
        if (error instanceof z.ZodError || error instanceof AppError && ['invalid_request', 'not_found', 'conflict'].includes(error.code)) return page(ctx, 'failed', 400);
        throw error;
      }
    }),
    // Only the server learns the Checkout URL, from the provider; the browser follows a same-origin link here.
    route({ method: 'get', path: '/join/checkout', permission: { kind: 'public' }, middleware: [steps], responses: html }, async ctx => {
      const linkId = pending(ctx), service = options().service;
      const state = linkId ? await service.state(gymOf(ctx), linkId) : { status: 'missing' as const };
      if (state.status === 'missing' || state.status === 'closed') return page(ctx, state.status);
      if (state.status === 'active') return ctx.redirect('/join/return', 303);
      try { return ctx.redirect(await service.checkout(gymOf(ctx), linkId!), 303); }
      catch (error) {
        // Paid, or a session being recorded, continues on the return page; a void invoice or revoked link cannot be paid here.
        if (settledOrGone(error)) return (await service.state(gymOf(ctx), linkId!)).status === 'closed' ? page(ctx, 'closed') : ctx.redirect('/join/return', 303);
        if (error instanceof AppError && error.code === 'unavailable') return page(ctx, 'unavailable', 503);
        throw error;
      }
    }),
    // Read-only: it waits for the webhook, which alone records the payment and activates the membership.
    route({ method: 'get', path: '/join/return', permission: { kind: 'public' }, responses: html }, async ctx => {
      const linkId = pending(ctx), service = options().service;
      const state = linkId ? await service.state(gymOf(ctx), linkId) : { status: 'missing' as const };
      if (state.status === 'missing' || state.status === 'closed') return page(ctx, state.status);
      if (state.status === 'pending') { ctx.header('Refresh', '5'); return page(ctx, 'confirming'); }
      return page(ctx, await service.passwordMode(gymOf(ctx)) ? 'welcomePassword' : 'welcomeEmail');
    }),
    route({ method: 'get', path: '/join/cancelled', permission: { kind: 'public' }, responses: html }, async ctx => {
      const linkId = pending(ctx), state = linkId ? await options().service.state(gymOf(ctx), linkId) : { status: 'missing' as const };
      if (state.status === 'active') return ctx.redirect('/join/return', 303);
      return state.status === 'pending' ? page(ctx, 'cancelled') : page(ctx, state.status);
    }),
    route({ method: 'post', path: '/join/sign-in', permission: { kind: 'public' }, middleware: [steps], responses: html }, async ctx => {
      const linkId = pending(ctx);
      if (!linkId) return page(ctx, 'missing');
      try { await options().service.resend(gymOf(ctx), linkId); }
      catch (error) { if (settledOrGone(error)) return ctx.redirect('/join/return', 303); throw error; }
      return page(ctx, 'resent');
    }),
    route({ method: 'post', path: '/join/portal-login', permission: { kind: 'public' }, middleware: [steps], responses: html }, async ctx => {
      const linkId = pending(ctx);
      if (!linkId) return page(ctx, 'missing');
      // Issues nothing: in password mode the gym checks the person and then issues the printed portal invitation.
      const service = options().service, gymId = gymOf(ctx);
      if (!await service.passwordMode(gymId) || (await service.state(gymId, linkId)).status !== 'active') return ctx.redirect('/join/return', 303);
      return page(ctx, 'welcomePassword');
    }),
    route({ method: 'get', path: '/join/client.js', permission: { kind: 'public' }, responses: { 200: { description: 'Progressive form enhancement' } } }, ctx => {
      ctx.header('Content-Type', 'text/javascript; charset=utf-8'); return ctx.body(joinBrowserScript);
    }),
  ];
  return result.map(protect);
}
export const routes = createJoinRoutes();
