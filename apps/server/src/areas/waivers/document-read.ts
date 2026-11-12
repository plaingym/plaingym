// SPDX-License-Identifier: AGPL-3.0-only
import { jsx } from 'hono/jsx';
import type { Context, MiddlewareHandler } from 'hono';
import { AppError, createTranslator } from '@plaingym/shared';
import type { RequestEnvironment } from '../../core/context.js';
import { rateLimit } from '../../core/rate-limit.js';
import { setPolicy } from '../../core/csp.js';
import messages from '../../../../../locales/en/waivers/waivers.json' with { type: 'json' };

export const documentReadBudget = 300;
const t = createTranslator({ 'waivers/waivers': messages });
/** A frame must explain a refusal without exposing a token or document details. */
export function documentRetryPage(ctx: Context<RequestEnvironment>, status: 429 | 404) {
  setPolicy(ctx, ["default-src 'none'", "style-src 'self'", "frame-ancestors 'self'"]);
  ctx.header('Cache-Control', 'private, no-store');
  ctx.header('Referrer-Policy', 'no-referrer');
  ctx.header('X-Content-Type-Options', 'nosniff');
  ctx.header('X-Frame-Options', 'SAMEORIGIN');
  ctx.header('Content-Type', 'text/html; charset=UTF-8');
  const text = (key: string) => t('waivers/waivers:' + key);
  return ctx.html('<!doctype html>' + jsx('html', { lang: 'en' },
    jsx('head', null, jsx('meta', { charset: 'utf-8' }), jsx('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      jsx('title', null, text('documentRetryTitle')), jsx('link', { rel: 'stylesheet', href: '/l/styles.css' })),
    jsx('body', { class: 'm-0 bg-background text-foreground' }, jsx('main', { class: 'mx-auto max-w-2xl space-y-4 px-4 py-6' },
      jsx('h1', { class: 'text-2xl font-bold' }, text('documentRetryTitle')),
      jsx('p', null, text(status === 429 ? 'documentRetryBody' : 'documentUnavailableBody')),
      jsx('footer', null, jsx('a', { href: '/source', target: '_blank', rel: 'noopener noreferrer', class: 'inline-flex min-h-11 items-center underline' }, text('documentSource')))))).toString(), status);
}
/** Frames and explicit opens share a larger, per-client read budget suitable for a gym's Wi-Fi. */
export function documentReadLimit(html: boolean | ((ctx: Context<RequestEnvironment>) => boolean) = false): MiddlewareHandler<RequestEnvironment> {
  const limit = rateLimit({ limit: documentReadBudget, windowMs: 60_000 });
  return async (ctx, next) => {
    const page = typeof html === 'function' ? html(ctx) : html;
    try { await limit(ctx, async () => {}); }
    catch (error) {
      if (page && error instanceof AppError && error.code === 'rate_limited') return documentRetryPage(ctx, 429);
      throw error;
    }
    await next();
    if (page && (ctx.res.status === 429 || ctx.res.status === 404)) ctx.res = documentRetryPage(ctx, ctx.res.status);
  };
}
