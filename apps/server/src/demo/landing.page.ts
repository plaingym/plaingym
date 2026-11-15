// SPDX-License-Identifier: AGPL-3.0-only
import { jsx as h } from 'hono/jsx';
import { createTranslator, type Translator } from '@plaingym/shared';
import { button, secondaryButton } from '../public/pages/page.js';
import messages from '../../../../locales/en/demo/product.json' with { type: 'json' };

const translator = createTranslator({ 'demo/product': messages });
export const demoLandingDirectives = ["default-src 'none'", "script-src 'none'", "style-src 'self'", "img-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"];

/** A release source URL may name a tag; the project CTA always opens its repository root. */
export function repositoryUrl(source: string): string {
  const url = new URL(source);
  url.pathname = '/' + url.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
  url.search = ''; url.hash = '';
  return url.href;
}

/** Entry-host product page: native links, the public stylesheet, and no JavaScript. */
export function demoLandingPage(showcaseHref: string, source: string, t: Translator = translator) {
  const text = (key: string) => t('demo/product:' + key);
  const actions = () => h('div', { class: 'flex flex-col gap-3 sm:flex-row' },
    h('a', { href: showcaseHref, class: button }, text('try')),
    h('a', { href: repositoryUrl(source), class: secondaryButton }, text('github')));
  const card = 'min-w-0 space-y-3 rounded-xl border border-border bg-card p-6';
  return '<!doctype html>' + h('html', { lang: 'en' },
    h('head', null, h('meta', { charset: 'utf-8' }), h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      h('meta', { name: 'color-scheme', content: 'light dark' }), h('meta', { name: 'description', content: text('pitch') }),
      h('title', null, text('title')), h('link', { rel: 'stylesheet', href: '/public/pages/styles.css' })),
    h('body', { class: 'm-0 bg-background font-sans text-foreground dark:bg-gray-950 dark:text-gray-100' },
      h('main', { class: 'mx-auto max-w-5xl space-y-12 px-4 py-10 sm:px-6 sm:py-16' },
        h('header', { class: 'max-w-3xl space-y-6' },
          h('p', { class: 'text-sm font-semibold uppercase tracking-widest' }, text('eyebrow')),
          h('h1', { class: 'text-5xl font-bold tracking-tight sm:text-6xl' }, text('name')),
          h('p', { class: 'text-xl leading-relaxed' }, text('pitch')), actions()),
        h('section', { class: 'space-y-6', 'aria-labelledby': 'strengths' },
          h('h2', { id: 'strengths', class: 'text-3xl font-semibold tracking-tight' }, text('strengths')),
          h('div', { class: 'grid gap-4 sm:grid-cols-2' }, ...['data', 'standards', 'open', 'selfHost'].map(key =>
            h('section', { class: card + ' dark:border-gray-700 dark:bg-gray-900' },
              h('h3', { class: 'text-xl font-semibold' }, text(key + 'Title')),
              h('p', { class: 'leading-relaxed' }, text(key + 'Body')))))),
        h('section', { class: 'space-y-6', 'aria-labelledby': 'features' },
          h('h2', { id: 'features', class: 'text-3xl font-semibold tracking-tight' }, text('features')),
          h('ul', { class: 'grid list-inside list-disc gap-3 sm:grid-cols-2' },
            ...['members', 'schedule', 'kiosk', 'billing', 'waivers', 'portal', 'website'].map(key => h('li', null, text(key))))),
        h('section', { class: 'space-y-6 rounded-xl bg-secondary p-6 text-secondary-foreground dark:bg-gray-900 dark:text-gray-100', 'aria-labelledby': 'explore' },
          h('h2', { id: 'explore', class: 'text-2xl font-semibold' }, text('explore')),
          h('p', { class: 'leading-relaxed' }, text('demoHelp')), actions())),
      h('footer', { class: 'mx-auto max-w-5xl px-4 pb-8 sm:px-6' },
        h('a', { href: '/source', class: 'inline-flex min-h-11 min-w-11 items-center underline' }, text('source'))))).toString();
}
