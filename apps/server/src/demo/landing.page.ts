// SPDX-License-Identifier: AGPL-3.0-only
import { jsx as h } from 'hono/jsx';
import { raw } from 'hono/html';
import { createTranslator, type Translator } from '@plaingym/shared';
import type { DemoIconName } from '../../../web/src/components/demo-icon.js';
import { demoIconMarkup } from '../../../web/src/components/demo-icon-markup.js';
import { buildLabel, buildLabelItem } from '../areas/health/build-label.js';
import { button, secondaryButton } from '../public/pages/page.js';
import messages from '../../../../locales/en/demo/product.json' with { type: 'json' };
import screenshots from './screenshots.json' with { type: 'json' };

const translator = createTranslator({ 'demo/product': messages });
export const demoLandingDirectives = ["default-src 'none'", "script-src 'none'", "style-src 'self'", "img-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"];
export const featureKeys = ['members', 'ranks', 'schedule', 'kiosk', 'portal', 'billing', 'waivers', 'join', 'reports', 'server'] as const;
const bulletCounts = [4, 4, 4, 4, 4, 5, 4, 3, 4, 5];
// The markup never changes, so render each icon once rather than on every request.
const iconMarkup = new Map<DemoIconName, string>();
const icon = (name: DemoIconName) => {
  if (!iconMarkup.has(name)) iconMarkup.set(name, demoIconMarkup(name));
  return raw(iconMarkup.get(name));
};

/** A release source URL may name a tag; the project CTA always opens its repository root. */
export function repositoryUrl(source: string): string {
  const url = new URL(source);
  url.pathname = '/' + url.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
  url.search = ''; url.hash = '';
  return url.href;
}

/** Entry-host product page: native links and popovers, with no JavaScript. */
export function demoLandingPage(showcaseHref: string, source: string, t: Translator = translator) {
  const text = (key: string) => t('demo/product:' + key);
  const actions = () => h('div', { class: 'flex flex-col gap-3 sm:flex-row' },
    h('a', { href: showcaseHref, class: button }, text('try')),
    h('a', { href: repositoryUrl(source), class: secondaryButton }, text('github')));
  const card = 'min-w-0 space-y-3 rounded-xl border border-border bg-card p-6 dark:border-gray-700 dark:bg-gray-900';
  const picture = (key: typeof featureKeys[number], expanded = false) => {
    const shot = screenshots[key], href = (file: string) => '/demo-assets/' + file;
    const sizes = expanded ? '(max-width: 768px) 94vw, 90vw' : shot.width < 500 ? '(max-width: 640px) 90vw, 360px' : '(max-width: 768px) 90vw, 600px';
    return h('picture', null,
      h('source', { media: '(prefers-color-scheme: dark)', srcset: `${href(shot.dark[0]!)} ${shot.width}w, ${href(shot.dark[1]!)} ${shot.width * 2}w`, sizes }),
      h('img', { src: href(shot.light[0]!), srcset: `${href(shot.light[0]!)} ${shot.width}w, ${href(shot.light[1]!)} ${shot.width * 2}w`, sizes,
        alt: text(key + 'Alt'), width: shot.width, height: shot.height, loading: 'lazy', decoding: 'async',
        class: expanded ? 'block max-h-[80dvh] max-w-full object-contain' : 'block h-auto w-full rounded-lg' }));
  };
  return '<!doctype html>' + h('html', { lang: 'en' },
    h('head', null, h('meta', { charset: 'utf-8' }), h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      h('meta', { name: 'color-scheme', content: 'light dark' }), h('meta', { name: 'description', content: text('pitch') }),
      h('title', null, text('title')), h('link', { rel: 'stylesheet', href: '/public/pages/styles.css' }),
      h('link', { rel: 'stylesheet', href: '/demo-assets/landing.css?v=1' })),
    h('body', { class: 'm-0 bg-background font-sans text-foreground dark:bg-gray-950 dark:text-gray-100' },
      h('main', { class: 'mx-auto max-w-6xl space-y-16 px-4 py-8 sm:px-6 sm:py-12' },
        h('header', { class: 'space-y-6 rounded-2xl border-t-4 border-primary bg-secondary p-6 text-secondary-foreground sm:p-12 dark:bg-gray-900 dark:text-gray-100' },
          h('p', { class: 'text-sm font-semibold uppercase tracking-widest' }, text('eyebrow')),
          h('h1', { class: 'text-5xl font-bold tracking-tight sm:text-7xl' }, text('name')),
          h('p', { class: 'max-w-2xl text-xl leading-relaxed sm:text-2xl' }, text('pitch')), actions()),
        h('section', { class: 'space-y-6', 'aria-labelledby': 'strengths' },
          h('h2', { id: 'strengths', class: 'text-3xl font-semibold tracking-tight' }, text('strengths')),
          h('div', { class: 'grid gap-4 sm:grid-cols-2 lg:grid-cols-4' }, ...(['data', 'standards', 'open', 'selfHost'] as const).map(key =>
            h('div', { class: card }, icon(key), h('h3', { class: 'text-xl font-semibold' }, text(key + 'Title')),
              h('p', { class: 'leading-relaxed' }, text(key + 'Body')))))),
        h('section', { class: 'space-y-6', 'aria-labelledby': 'features' },
          h('h2', { id: 'features', class: 'text-3xl font-semibold tracking-tight' }, text('features')),
          h('nav', { 'aria-labelledby': 'features', class: 'grid gap-3 sm:grid-cols-2 lg:grid-cols-5' }, ...featureKeys.map(key =>
            h('a', { href: '#feature-' + key, class: 'flex min-h-11 min-w-0 items-center gap-3 rounded-lg border border-border p-4 text-sm font-semibold dark:border-gray-700' },
              h('span', { class: 'shrink-0' }, icon(key)), text(key + 'Title'))))),
        ...featureKeys.map((key, index) => h('section', { id: 'feature-' + key, class: 'demo-feature grid scroll-mt-6 items-center gap-8 border-t border-border pt-12 md:grid-cols-2 dark:border-gray-700', 'aria-labelledby': key + '-heading' },
          h('div', { class: 'min-w-0 space-y-5' }, h('span', { class: 'inline-flex rounded-xl bg-secondary p-3 text-primary' }, icon(key)),
            h('h2', { id: key + '-heading', class: 'text-3xl font-semibold tracking-tight' }, text(key + 'Title')),
            h('p', { class: 'text-lg leading-relaxed' }, text(key + 'Lead')),
            h('ul', { class: 'list-disc space-y-2 pl-5 leading-relaxed' }, ...Array.from({ length: bulletCounts[index]! }, (_, i) => h('li', null, text(key + 'Bullet' + (i + 1))))),
            key === 'billing' ? h('div', { class: 'space-y-3 text-sm leading-relaxed' }, h('p', null, text('billingHelp')), h('p', { class: 'rounded-lg bg-secondary p-4 text-secondary-foreground' }, text('billingTest'))) : null),
          h('figure', { class: screenshots[key].width < 500 ? 'mx-auto w-full max-w-sm space-y-2' : 'min-w-0 space-y-2' },
            h('button', { type: 'button', tabindex: 0, popovertarget: 'shot-' + key, class: 'demo-zoom block w-full cursor-zoom-in rounded-xl border border-border bg-muted p-2 shadow-lg', 'aria-label': text('enlarge') + ': ' + text(key + 'Title') }, picture(key)),
            h('a', { class: 'demo-original inline-flex min-h-11 min-w-11 items-center text-sm underline', href: '/demo-assets/' + screenshots[key].light[1] },
              h('span', { class: 'demo-fallback-image' }, picture(key)), text('original'))),
          h('div', { id: 'shot-' + key, popover: 'auto', class: 'demo-lightbox', role: 'dialog', 'aria-label': text(key + 'Title') },
            h('button', { type: 'button', tabindex: 0, popovertarget: 'shot-' + key, popovertargetaction: 'hide', class: 'demo-close', autofocus: true }, text('close')),
            picture(key, true)))),
        h('section', { class: 'space-y-6 rounded-xl bg-secondary p-6 text-secondary-foreground sm:p-8 dark:bg-gray-900 dark:text-gray-100', 'aria-labelledby': 'explore' },
          h('h2', { id: 'explore', class: 'text-3xl font-semibold' }, text('explore')),
          h('ol', { class: 'grid gap-6 md:grid-cols-3' }, ...[1, 2, 3].map(step => h('li', { class: 'space-y-2' },
            h('span', { class: 'inline-flex h-11 w-11 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground', 'aria-hidden': 'true' }, step),
            h('h3', { class: 'text-lg font-semibold' }, text('step' + step + 'Title')), h('p', { class: 'leading-relaxed' }, text('step' + step + 'Body'))))), actions())),
      h('footer', { class: 'mx-auto flex max-w-6xl flex-wrap gap-6 px-4 py-8 sm:px-6' },
        ...[['/source', 'source'], [repositoryUrl(source) + '/blob/main/LICENSE', 'license'], [repositoryUrl(source) + '/blob/main/docs/self-hosting.md', 'selfHosting']].map(([href, key]) =>
          h('a', { href, class: 'inline-flex min-h-11 min-w-11 items-center underline' }, text(key!))), buildLabelItem(undefined, buildLabel(undefined, source))))).toString();
}
