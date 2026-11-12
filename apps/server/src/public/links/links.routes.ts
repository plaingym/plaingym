// SPDX-License-Identifier: AGPL-3.0-only
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { AppError, createTranslator, type Translator } from '@plaingym/shared';
import { portalSignedLinkContracts as contracts, signedLinkActionContracts as actions, signedLinkCardUnavailableSchema, portalAccessContracts, waiverDocumentReadContracts } from '@plaingym/shared/contracts';
import type { PortalInvitationService } from '../../areas/members/household-users.invitations.js';
import { failureBudget, rateLimit } from '../../core/rate-limit.js';
import { documentReadLimit } from '../../areas/waivers/document-read.js';
import { setPolicy } from '../../core/csp.js';
import { route, type RouteRegistration } from '../../core/registry.js';
import type { RequestEnvironment } from '../../core/context.js';
import { createSignedLinksService } from '../../areas/links/service.js';
import { CustomerNotLinked } from '../../areas/billing/signed-link-checkout.js';
import { createSettingsService } from '../../areas/settings/settings.js';
import { createLinkPageService, linkPrincipal, type LinkPageOptions, type LinkPageService } from './service.js';
import { checkoutReceipts } from './receipt.js';
import { linkPage } from './page.js';
import { cachedLinkAsset } from './assets.js';
import messages from '../../../../../locales/en/public/links.json' with { type: 'json' };
import waiverMessages from '../../../../../locales/en/waivers/waivers.json' with { type: 'json' };
import unsubscribeMessages from '../../../../../locales/en/links/unsubscribe.json' with { type: 'json' };

const t = createTranslator({ 'public/links': messages, 'waivers/waivers': waiverMessages, 'links/unsubscribe': unsubscribeMessages });
const settings = createSettingsService();
export const receiptCookie = 'plaingym_link_checkout';
/** One-click POSTs whose token doesn't resolve, per client and gym each minute: the flood limit's default. */
export const oneClickGuessBudget = 300;
const stylesheet = cachedLinkAsset('./public/links.css'), browserScript = cachedLinkAsset('./public/links.js');
/** Signed-link pages load their script, styles and images (`data:` QR codes) from the app only. */
const linkPageDirectives = ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "img-src 'self' data:", "base-uri 'none'",
  "form-action 'self'", "frame-src 'self'", "frame-ancestors 'none'"];
interface PageRoutesOptions {
  gymNameFor?: (gymId: string) => Promise<string>;
  portalInvitations?: PortalInvitationService;
  service: LinkPageService;
  links: Pick<ReturnType<typeof createSignedLinksService>, 'resolve'>;
  receipts: ReturnType<typeof checkoutReceipts>;
  t?: Translator;
  localeFor?: (gymId: string) => string | Promise<string>;
  stylesheet?: () => Promise<string>;
  browserScript?: () => Promise<string>;
}
let configured: PageRoutesOptions | undefined;
/** Runtime supplies real services, canonical payment origins and a stable receipt key. */
export function configureLinkPages(options: LinkPageOptions & { gymNameFor?: PageRoutesOptions['gymNameFor']; portalInvitations?: PortalInvitationService; receiptKey: Uint8Array; links?: PageRoutesOptions['links']; t?: Translator; localeFor?: PageRoutesOptions['localeFor']; stylesheet?: () => Promise<string>; browserScript?: () => Promise<string> }) {
  const service = createLinkPageService(options);
  configured = { service, ...(options.portalInvitations ? { portalInvitations: options.portalInvitations } : {}), links: options.links ?? createSignedLinksService(), receipts: checkoutReceipts(options.receiptKey),
    ...(options.gymNameFor ? { gymNameFor: options.gymNameFor } : {}), ...(options.t ? { t: options.t } : {}), ...(options.localeFor ? { localeFor: options.localeFor } : {}), ...(options.stylesheet ? { stylesheet: options.stylesheet } : {}), ...(options.browserScript ? { browserScript: options.browserScript } : {}) };
  return service;
}
export function createLinkRoutes(supplied?: PageRoutesOptions): readonly RouteRegistration[] {
  const options = () => supplied ?? configured ?? (() => { throw new AppError('unavailable', 'Signed-link pages are not configured'); })();
  async function presentation(c: Context<RequestEnvironment>) {
    const ctx = c.get('context'), config = options();
    return { now: ctx.clock.now(), timezone: ctx.gym.timezone, t: config.t ?? t,
      portalClaim: config.portalInvitations ? { password: await config.portalInvitations.passwordRequired(ctx.gym.gymId) } : undefined,
      locale: await config.localeFor?.(ctx.gym.gymId) ?? 'en' };
  }
  const empty = z.strictObject({});
  const unsubscribeLimit = rateLimit({ sharedKey: 'links.unsubscribe', limit: 30 });
  const unknownOneClicks = failureBudget({ limit: oneClickGuessBudget });
  const json = <T extends z.ZodType>(schema: T) => ({ 200: { description: 'Signed-link result', content: { 'application/json': { schema } } } });
  function protect(entry: RouteRegistration, bearer = true): RouteRegistration {
    return { ...entry, mount(app, authorize) {
      entry.mount(app, permission => async (c, next) => {
        c.header('Cache-Control', 'no-store, private');
        c.header('Referrer-Policy', 'no-referrer');
        c.header('X-Robots-Tag', 'noindex, nofollow');
        c.header('X-Content-Type-Options', 'nosniff');
        if (bearer) {
          const token = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(c.req.header('authorization') ?? '')?.[1];
          if (!token) throw new AppError('unauthenticated', 'Signed link required');
          const resolved = await options().links.resolve(c.get('context').gym.gymId, token);
          if (resolved.status !== 'active') throw new AppError('not_found', 'Link not found');
          c.set('context', { ...c.get('context'), principal: resolved.principal });
        }
        return authorize(permission)(c, next);
      });
    } };
  }
  function html(c: Context<RequestEnvironment>, input: Parameters<typeof linkPage>[0], status: 200 | 404 = 200) {
    setPolicy(c, linkPageDirectives);
    const token = c.req.param('token');
    return c.html(linkPage({ ...input, ...(token ? { documentBase: '/l/' + encodeURIComponent(token) + '/documents/' } : {}) }), status);
  }
  const textResponses = { 200: { description: 'Signed-link page' }, 404: { description: 'Unavailable signed link' } };
  const publicRoute = (entry: RouteRegistration) => protect(entry, false);
  const result: RouteRegistration[] = [
    protect(route({ ...waiverDocumentReadContracts.link, middleware: documentReadLimit(),
      request: { params: waiverDocumentReadContracts.link.params }, responses: json(waiverDocumentReadContracts.link.response) }, async c =>
      c.json(await options().service.document(c.get('context'), c.req.valid('param').templateId), 200))),
    publicRoute(route({ method: 'get', path: '/l/{token}/documents/{templateId}', permission: { kind: 'public' }, middleware: documentReadLimit(true),
      request: { params: z.strictObject({ token: z.string().max(128), templateId: z.uuid() }) }, responses: { 302: { description: 'Open the waiver document' } } }, async c => {
      const context = c.get('context'), params = c.req.valid('param');
      const resolved = await options().links.resolve(context.gym.gymId, params.token);
      if (resolved.status !== 'active') throw new AppError('not_found', 'Document not found');
      const result = await options().service.document({ ...context, principal: resolved.principal }, params.templateId);
      return c.redirect(result.data.url, 302);
    })),
    publicRoute(route({ method: 'get', path: '/l/client.js', permission: { kind: 'public' }, responses: { 200: { description: 'Signed-link progressive enhancement' } } }, async c => {
      c.header('Content-Type', 'text/javascript; charset=utf-8'); return c.body(await (options().browserScript ?? browserScript)());
    })),
    publicRoute(route({ method: 'get', path: '/l/styles.css', permission: { kind: 'public' }, responses: { 200: { description: 'Signed-link styles' } } }, async c => {
      c.header('Content-Type', 'text/css; charset=utf-8');
      return c.body(await (options().stylesheet ?? stylesheet)());
    })),
    publicRoute(route({ method: 'get', path: '/l/cleared', permission: { kind: 'public' }, responses: textResponses }, async c => {
      deleteCookie(c, receiptCookie, { path: '/' });
      return html(c, { ...await presentation(c), state: 'cleared' });
    })),
    publicRoute(route({ method: 'get', path: '/l/return', permission: { kind: 'public' }, responses: { 302: { description: 'Return to the signed-link page' }, 404: { description: 'Unavailable return' } } }, async c => {
      const ctx = c.get('context'), receipt = options().receipts.open(getCookie(c, receiptCookie), ctx.clock.now(), { gymId: ctx.gym.gymId });
      if (!receipt) return html(c, { ...await presentation(c), state: 'unavailable' }, 404);
      return c.redirect('/l/' + receipt.token + '?returned=1' + (receipt.tablet ? '&tablet=1' : ''), 302);
    })),
    publicRoute(route({ method: 'get', path: '/l/{token}', permission: { kind: 'public' },
      request: { params: z.object({ token: z.string().max(128) }), query: z.strictObject({ tablet: z.literal('1').optional(), returned: z.literal('1').optional() }) }, responses: textResponses }, async c => {
      const ctx = c.get('context'), config = options();
      const resolution = await config.links.resolve(ctx.gym.gymId, c.req.valid('param').token);
      const common = { ...await presentation(c), tablet: c.req.valid('query').tablet === '1' };
      if (resolution.status !== 'active') {
        // This is static guidance, never proof a credential or household exists. Other gyms see the same page.
        const replaced = resolution.status === 'not_found' && /^campaign_[A-Za-z0-9_-]{43}$/.test(c.req.valid('param').token);
        return html(c, { ...common, state: resolution.status === 'used' ? 'alreadyDone' : replaced ? 'replaced' : 'unavailable' }, resolution.status === 'used' ? 200 : 404);
      }
      try {
        const verified = { ...ctx, principal: resolution.principal };
        const data = await config.service.read(verified);
        if (data.purpose === 'sign_waiver' && await config.service.completeWaiverOnOpen(verified))
          return html(c, { ...common, state: 'alreadyDone' });
        const gymName = data.purpose === 'unsubscribe'
          ? await (config.gymNameFor ?? (async gymId => (await settings.get(gymId)).name))(ctx.gym.gymId) : undefined;
        return html(c, { ...common, data, ...(gymName ? { gymName } : {}) });
      } catch (error) {
        if (error instanceof AppError && error.code === 'not_found') return html(c, { ...common, state: 'unavailable' }, 404);
        throw error;
      }
    })),
  ];
  // The app's flood limit skips this POST (RFC 8058 providers share source addresses). Valid one-clicks share a large
  // budget (repeating one is harmless); a token that doesn't resolve is also charged to a per-client budget the size
  // of the flood limit, which refuses that client before any database work once it is spent.
  const oneClick = contracts.oneClickUnsubscribe;
  // A token the contract refuses can't resolve either: charge it and answer the same 404 before the shared counter's
  // database write, which runs ahead of the parameter check.
  const malformedOneClick: MiddlewareHandler<RequestEnvironment> = async (c, next) => {
    if (!oneClick.params.safeParse({ token: c.req.param('token') }).success) {
      unknownOneClicks.charge(c);
      throw new AppError('not_found', 'Link not found');
    }
    await next();
  };
  result.push(publicRoute(route({ ...oneClick, middleware: [unknownOneClicks.check, malformedOneClick, rateLimit({ sharedKey: 'links.unsubscribe.oneClick', limit: 10_000 })],
    request: { params: oneClick.params, query: empty }, responses: json(oneClick.response) }, async c => {
    const ctx = c.get('context'), config = options();
    const resolved = await config.links.resolve(ctx.gym.gymId, c.req.valid('param').token);
    if (resolved.status !== 'active' || resolved.principal.link.purpose !== 'unsubscribe') {
      unknownOneClicks.charge(c);
      throw new AppError('not_found', 'Link not found');
    }
    // RFC 8058: mail clients send the one field as multipart/form-data (SHOULD) or URL-encoded (MAY).
    const type = c.req.header('content-type') ?? '';
    const fields = /^multipart\/form-data\s*;/i.test(type) ? [...(await c.req.formData().catch(() => new FormData())).entries()] : [];
    const oneClickBody = /^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(type)
      ? await c.req.text() === 'List-Unsubscribe=One-Click'
      : fields.length === 1 && fields[0]![0] === 'List-Unsubscribe' && fields[0]![1] === 'One-Click';
    if (!oneClickBody) throw new AppError('invalid_request', 'Invalid one-click request');
    await config.service.announcementPreference({ ...ctx, principal: resolved.principal }, true);
    return c.json({ data: { optedOut: true as const } }, 200);
  })));
  const preference = contracts.announcementPreference;
  result.push(protect(route({ ...preference, middleware: unsubscribeLimit,
    request: { query: empty, body: { content: { 'application/json': { schema: preference.body } }, required: true } },
    responses: json(preference.response) }, async c => c.json(preference.response.parse({
      data: await options().service.announcementPreference(c.get('context'), c.req.valid('json').optedOut),
    }), 200))));
  for (const name of ['invoice', 'card', 'waiver', 'onboarding', 'unsubscribe'] as const) {
    const contract = contracts[name];
    result.push(protect(route({ ...contract, request: { query: empty }, responses: json(contract.response) }, async c =>
      c.json(contract.response.parse({ data: await options().service.read(c.get('context')) }), 200))));
  }
  for (const name of ['payInvoice', 'updateCard', 'onboardCard'] as const) {
    const contract = contracts[name];
    result.push(protect(route({ ...contract, request: { query: empty, body: { content: { 'application/json': { schema: empty } }, required: true } },
      responses: { 200: { description: 'Checkout redirect', content: { 'application/json': { schema: contract.response } } },
        503: { description: 'Customer is not linked', content: { 'application/json': { schema: signedLinkCardUnavailableSchema } } } } }, async c => {
      const ctx = c.get('context'), p = linkPrincipal(ctx), config = options();
      try {
        const { session, expiresAt } = await config.service.checkout(ctx);
        const token = c.req.header('authorization')!.slice(7);
        const cookie = config.receipts.seal({ token, gymId: p.gymId, linkId: p.linkId, sessionId: session.id,
          expires: Date.parse(expiresAt), tablet: c.req.header('x-link-tablet') === 'true' });
        // /l/return and /api/links/*/complete share only the root path. The encrypted
        // receipt is HttpOnly and is accepted only with its gym/link binding.
        setCookie(c, receiptCookie, cookie, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/',
          maxAge: Math.max(1, Math.floor((Date.parse(expiresAt) - ctx.clock.now().getTime()) / 1000)) });
        return c.json(contract.response.parse({ data: { url: session.url, expiresAt } }), 200);
      } catch (error) {
        if (error instanceof CustomerNotLinked) return c.json({ cardSetupUnavailable: true as const }, 503);
        throw error;
      }
    })));
  }
  for (const name of ['signWaiver', 'onboardWaiver'] as const) {
    const contract = contracts[name];
    result.push(protect(route({ ...contract, request: { query: empty, body: { content: { 'application/json': { schema: contract.body } }, required: true } }, responses: json(contract.response) }, async c =>
      c.json({ data: await options().service.sign(c.get('context'), c.req.valid('json')) }, 200))));
  }
  for (const name of ['uploadWaiver', 'uploadOnboarding'] as const) {
    const contract = actions[name];
    result.push(protect(route({ ...contract, request: { query: empty, body: { content: { 'application/json': { schema: contract.body } }, required: true } }, responses: json(contract.response) }, async c => {
      const input = c.req.valid('json');
      return c.json({ data: await options().service.upload(c.get('context'), input.pngBase64, 'memberId' in input ? input.memberId : undefined) }, 200);
    })));
  }
  for (const name of ['completeInvoice', 'completeCard', 'completeOnboarding'] as const) {
    const contract = actions[name];
    result.push(protect(route({ ...contract, request: { query: empty, body: { content: { 'application/json': { schema: empty } }, required: true } }, responses: json(contract.response) }, async c => {
      const ctx = c.get('context'), p = linkPrincipal(ctx), config = options();
      const receipt = config.receipts.open(getCookie(c, receiptCookie), ctx.clock.now(), { gymId: p.gymId, linkId: p.linkId });
      const sessionId = receipt?.gymId === p.gymId && receipt.linkId === p.linkId ? receipt.sessionId : null;
      const completed = await config.service.complete(ctx, sessionId);
      if (completed) deleteCookie(c, receiptCookie, { path: '/' });
      return c.json({ data: { completed } }, 200);
    })));
  }
  const claim = portalAccessContracts.claimOnboarding;
  result.push(protect(route({ ...claim, middleware: rateLimit({ sharedKey: 'links.claim', limit: 10 }), request: { query: empty, body: { required: true, content: { 'application/json': { schema: claim.body } } } }, responses: json(claim.response) }, async c => {
    const ctx = c.get('context'), principal = linkPrincipal(ctx), service = options().portalInvitations;
    if (!service) throw new AppError('unavailable', 'Portal invitations are not configured');
    return c.json(await service.claimOnboarding(principal.gymId, principal.linkId, c.req.valid('json'), ctx.clock), 200);
  })));
  return result;
}
export const routes = createLinkRoutes();
