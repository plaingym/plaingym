// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { jsx as h } from 'hono/jsx';
import { raw } from 'hono/html';
import { createTranslator, type Translator } from '@plaingym/shared';
import type { DemoIconName } from '../../../web/src/components/demo-icon.js';
import { demoIconMarkup } from '../../../web/src/components/demo-icon-markup.js';
import { buildLabel, buildLabelItem } from '../areas/health/build-label.js';
import messages from '../../../../locales/en/demo/product.json' with { type: 'json' };
import screenshots from './screenshots.json' with { type: 'json' };

const translator = createTranslator({ 'demo/product': messages });
export const demoLandingDirectives = ["default-src 'none'", "script-src 'none'", "style-src 'self'", "img-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"];
export const featureKeys = ['members', 'ranks', 'schedule', 'kiosk', 'portal', 'billing', 'waivers', 'join', 'reports', 'server'] as const;
type FeatureKey = typeof featureKeys[number];
/** The bullets each feature has in the locale file: `<key>Bullet1`, `<key>Bullet2`, ... */
const bulletsByFeature = new Map(featureKeys.map(key => [key, Object.keys(messages).filter(name => new RegExp(`^${key}Bullet\\d+$`).test(name))
  .sort((a, b) => Number(a.slice(key.length + 6)) - Number(b.slice(key.length + 6)))]));
export const bulletKeys = (key: FeatureKey): string[] => bulletsByFeature.get(key) ?? [];
/** The page's own stylesheet (popovers, backdrops and fallbacks), named by its content so a changed file is never served stale.
 * The server build copies `screenshots/` beside the bundle, so the same relative path works from source and from the bundle. */
const landingCss = readFileSync(new URL('./screenshots/landing.css', import.meta.url));
export const landingStylesheet = { file: `landing-${createHash('sha256').update(landingCss).digest('hex').slice(0, 16)}.css`, body: landingCss } as const;
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

// One spacing scale (Tailwind's 4/6/8/12/16/24 steps) and one type scale (sm, base, lg, xl, 3xl/4xl, 4xl-6xl) throughout.
// demo-gutter (landing.css) keeps the page clear of a notch in landscape, since the viewport covers the safe areas.
const container = 'mx-auto w-full max-w-6xl demo-gutter';
// Every control: a 44 px target, a visible keyboard ring in both themes and colour changes that stop under reduced motion.
const ring = 'outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring dark:focus-visible:outline-teal-300';
const motion = 'transition-colors motion-reduce:transition-none';
const control = `inline-flex min-h-11 min-w-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold ${motion}`;
const primary = `${control} ${ring} bg-primary text-white shadow-sm hover:bg-teal-900 active:bg-teal-950 dark:bg-teal-700 dark:hover:bg-teal-800 dark:active:bg-teal-900`;
const secondary = `${control} ${ring} border border-border bg-white text-foreground shadow-sm hover:bg-muted active:bg-secondary dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800 dark:active:bg-gray-700`;
// On the brand band the actions invert, and the keyboard ring is white in both themes.
const bandRing = 'outline-offset-2 focus-visible:outline-2 focus-visible:outline-white';
const bandPrimary = `${control} ${bandRing} bg-white text-teal-900 shadow-sm hover:bg-teal-50 active:bg-teal-100`;
const bandSecondary = `${control} ${bandRing} border border-white/70 text-white hover:bg-white/15 active:bg-white/25`;
const navLink = `${control} ${ring} px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground active:bg-secondary dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white dark:active:bg-gray-700`;
// Inside a menu panel the ring sits inside the item, so the panel's edge never clips it.
const menuLink = `flex min-h-11 w-full items-center gap-3 rounded-lg px-3 font-semibold ${motion} -outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring hover:bg-muted active:bg-secondary dark:hover:bg-gray-800 dark:focus-visible:outline-teal-300 dark:active:bg-gray-700`;
const footerLink = `inline-flex min-h-11 items-center rounded-sm ${ring} ${motion} text-muted-foreground underline-offset-4 hover:text-foreground hover:underline dark:text-gray-400 dark:hover:text-white`;
const iconTile = 'inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary dark:bg-teal-950 dark:text-teal-300';
const sectionTitle = 'text-3xl font-bold tracking-tight sm:text-4xl';
const muted = 'text-muted-foreground dark:text-gray-400';

/** Entry-host product page: native links and popovers, with no JavaScript. */
export function demoLandingPage(showcaseHref: string, source: string, t: Translator = translator) {
  const text = (key: string) => t('demo/product:' + key);
  const repository = repositoryUrl(source);
  const withIcon = (name: DemoIconName, label: string) => [h('span', { class: 'shrink-0 demo-icon' }, icon(name)), label];
  const actions = (band = false) => h('div', { class: 'flex flex-col gap-3 sm:flex-row' },
    h('a', { href: showcaseHref, class: (band ? bandPrimary : primary) + ' px-6 py-3' }, ...withIcon('play', text('try'))),
    h('a', { href: repository, class: (band ? bandSecondary : secondary) + ' px-6 py-3' }, ...withIcon('github', text('github'))));
  const sectionLinks = [['#strengths', 'navWhy'], ['#features', 'navFeatures'], ['#explore', 'explore']] as const;
  // One list of links feeds the desktop row and both phone menus (popover, and a details fallback).
  const menuItems = () => [...sectionLinks.map(([href, key]) => h('li', null, h('a', { href, class: menuLink }, text(key)))),
    h('li', null, h('a', { href: showcaseHref, class: menuLink }, ...withIcon('play', text('try')))),
    h('li', null, h('a', { href: repository, class: menuLink }, ...withIcon('github', text('github'))))];
  const panel = 'w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-white p-2 text-foreground shadow-xl dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';
  // Sticky on every width: a row of links from lg up, below that the call to action and a menu button. The popover
  // panel is fixed just below the header (landing.css); the details panel hangs from it.
  const siteHeader = () => h('header', { class: 'sticky top-0 z-40 border-b border-border bg-white/90 pt-[env(safe-area-inset-top)] backdrop-blur dark:border-gray-800 dark:bg-gray-950/90' },
    h('div', { class: container + ' relative flex h-16 items-center gap-2' },
      h('a', { href: '/', class: `mr-auto inline-flex min-h-11 items-center rounded-sm text-xl font-bold tracking-tight ${ring}` }, text('name')),
      h('nav', { 'aria-label': text('navLabel'), class: 'hidden items-center gap-1 lg:flex' },
        ...sectionLinks.map(([href, key]) => h('a', { href, class: navLink }, text(key))),
        h('a', { href: showcaseHref, class: primary + ' ml-3 px-4 text-sm' }, ...withIcon('play', text('try'))),
        h('a', { href: repository, class: secondary + ' px-4 text-sm' }, ...withIcon('github', text('github')))),
      h('a', { href: showcaseHref, class: primary + ' px-4 text-sm lg:hidden' }, ...withIcon('play', text('try'))),
      h('button', { type: 'button', popovertarget: 'site-menu', class: secondary + ' demo-menu-button lg:hidden', 'aria-label': text('menu') }, icon('menu')),
      h('div', { id: 'site-menu', popover: 'auto', class: 'demo-menu ' + panel }, h('ul', null, ...menuItems())),
      h('details', { class: 'demo-menu-fallback' },
        h('summary', { class: secondary + ' cursor-pointer', 'aria-label': text('menu') }, icon('menu')),
        h('ul', { class: panel + ' absolute top-full right-4 z-50 mt-1' }, ...menuItems()))));
  const picture = (key: FeatureKey, mode: 'inline' | 'hero' | 'expanded') => {
    const shot = screenshots[key], href = (file: string) => '/demo-assets/' + file;
    // Expanded on a phone held upright, a screenshot keeps its own width and scrolls inside the lightbox (landing.css).
    const sizes = mode === 'expanded' ? `(max-width: 767px) and (orientation: portrait) ${shot.width}px, 90vw`
      : mode === 'hero' ? '(min-width: 1152px) 640px, (min-width: 1024px) 55vw, 92vw'
        : shot.width < 500 ? '(min-width: 640px) 384px, 92vw' : '(min-width: 1152px) 540px, (min-width: 768px) 45vw, 92vw';
    const srcset = (files: string[]) => `${href(files[0]!)} ${shot.width}w, ${href(files[1]!)} ${shot.width * 2}w`;
    const dark = shot.dark.some((file, index) => file !== shot.light[index]);
    return h('picture', null,
      dark ? h('source', { media: '(prefers-color-scheme: dark)', srcset: srcset(shot.dark), sizes }) : null,
      h('img', { src: href(shot.light[0]!), srcset: srcset(shot.light), sizes,
        alt: text(key + 'Alt'), width: shot.width, height: shot.height, loading: mode === 'hero' ? 'eager' : 'lazy', decoding: 'async',
        ...(mode === 'hero' ? { fetchpriority: 'high' } : {}), class: mode === 'expanded' ? 'demo-expanded' : 'block h-auto w-full rounded-lg' }));
  };
  const frame = 'rounded-xl border border-border bg-white p-1.5 shadow-xl shadow-gray-900/10 dark:bg-card dark:shadow-black/40';
  const feature = (key: FeatureKey, index: number) => {
    const narrow = screenshots[key].width < 500;
    return h('section', { id: 'feature-' + key, class: 'grid items-center gap-8 py-12 sm:py-16 md:grid-cols-2 lg:gap-16', 'aria-labelledby': key + '-heading' },
      // Screenshots alternate sides from md up; the text stays first in the source for reading order.
      h('div', { class: 'min-w-0 space-y-4' + (index % 2 === 0 ? ' md:order-last' : '') },
        h('span', { class: iconTile }, icon(key)),
        h('h2', { id: key + '-heading', class: 'text-2xl font-bold tracking-tight sm:text-3xl' }, text(key + 'Title')),
        h('p', { class: 'text-lg ' + muted }, text(key + 'Lead')),
        h('ul', { class: 'list-disc space-y-2 pl-5 marker:text-primary dark:marker:text-teal-400' }, ...bulletKeys(key).map(bullet => h('li', null, text(bullet)))),
        key === 'billing' ? h('div', { class: 'space-y-3 text-sm' }, h('p', { class: muted }, text('billingHelp')),
          h('p', { class: 'rounded-lg border-l-4 border-primary bg-muted p-4 text-foreground dark:border-teal-400 dark:bg-gray-900 dark:text-gray-100' }, text('billingTest'))) : null),
      h('figure', { class: narrow ? 'mx-auto w-full max-w-sm' : 'min-w-0' },
        h('button', { type: 'button', tabindex: 0, popovertarget: 'shot-' + key, class: `demo-zoom block w-full cursor-zoom-in ${frame} ${ring} transition-shadow hover:shadow-2xl motion-reduce:transition-none`, 'aria-label': text('enlarge') + ': ' + text(key + 'Title') }, picture(key, 'inline')),
        h('a', { class: 'demo-original mt-2 inline-flex min-h-11 min-w-11 items-center rounded-sm text-sm underline underline-offset-4 ' + ring + ' ' + muted + ' hover:text-foreground dark:hover:text-white', href: '/demo-assets/' + screenshots[key].light[1] },
          h('span', { class: 'demo-fallback-image' }, picture(key, 'inline')), text('original'))),
      h('div', { id: 'shot-' + key, popover: 'auto', class: 'demo-lightbox', role: 'dialog', 'aria-label': text(key + 'Title') },
        h('button', { type: 'button', tabindex: 0, popovertarget: 'shot-' + key, popovertargetaction: 'hide', class: 'demo-close', autofocus: true }, text('close')),
        picture(key, 'expanded')));
  };
  return '<!doctype html>' + h('html', { lang: 'en', class: 'theme-system' },
    h('head', null, h('meta', { charset: 'utf-8' }), h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' }),
      h('meta', { name: 'color-scheme', content: 'light dark' }), h('meta', { name: 'description', content: text('pitch') }),
      h('title', null, text('title')), h('link', { rel: 'stylesheet', href: '/public/pages/styles.css' }),
      h('link', { rel: 'stylesheet', href: '/demo-assets/' + landingStylesheet.file })),
    h('body', { class: 'm-0 bg-white font-sans text-base leading-relaxed text-foreground antialiased dark:bg-gray-950 dark:text-gray-100' },
      siteHeader(),
      h('main', null,
        h('header', { class: 'border-b border-border bg-linear-to-b from-secondary to-white dark:border-gray-800 dark:from-gray-900 dark:to-gray-950' },
          h('div', { class: container + ' grid items-center gap-12 py-16 sm:py-24 lg:grid-cols-12 lg:gap-12' },
            h('div', { class: 'min-w-0 space-y-6 lg:col-span-5' },
              h('p', { class: 'inline-flex rounded-full border border-primary/25 bg-white px-3 py-1 text-sm font-semibold text-primary dark:border-teal-800 dark:bg-gray-900 dark:text-teal-300' }, text('eyebrow')),
              h('h1', { class: 'text-5xl font-bold tracking-tight sm:text-6xl' }, text('name')),
              h('p', { class: 'max-w-xl text-xl text-muted-foreground sm:text-2xl dark:text-gray-300' }, text('pitch')), actions()),
            h('div', { class: 'min-w-0 lg:col-span-7' }, h('div', { class: frame }, picture('schedule', 'hero'))))),
        h('section', { class: container + ' py-16 sm:py-24', 'aria-labelledby': 'strengths' },
          h('h2', { id: 'strengths', class: sectionTitle }, text('strengths')),
          h('div', { class: 'mt-8 grid gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4' }, ...(['data', 'standards', 'open', 'selfHost'] as const).map(key =>
            h('div', { class: 'min-w-0 rounded-2xl border border-border bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900' },
              h('span', { class: iconTile }, icon(key)), h('h3', { class: 'mt-4 text-lg font-semibold' }, text(key + 'Title')),
              h('p', { class: 'mt-2 ' + muted }, text(key + 'Body')))))),
        h('div', { class: 'border-y border-border bg-muted dark:border-gray-800 dark:bg-gray-900/50' },
          h('section', { class: container + ' py-16 sm:py-24', 'aria-labelledby': 'features' },
            h('h2', { id: 'features', class: sectionTitle }, text('features')),
            h('nav', { 'aria-labelledby': 'features', class: 'mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5' }, ...featureKeys.map(key =>
              h('a', { href: '#feature-' + key, class: `flex min-h-11 min-w-0 items-center gap-3 rounded-xl border border-border bg-white px-3 py-3 text-sm font-semibold ${ring} ${motion} hover:border-primary hover:bg-secondary active:bg-teal-100 sm:px-4 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-teal-400 dark:hover:bg-gray-800 dark:active:bg-gray-700` },
                h('span', { class: 'shrink-0 text-primary dark:text-teal-300' }, icon(key)), h('span', { class: 'min-w-0' }, text(key + 'Title'))))))),
        h('div', { class: container + ' py-4 sm:py-8' }, ...featureKeys.map(feature)),
        h('div', { class: container + ' pb-16 sm:pb-24' },
          h('section', { class: 'rounded-3xl bg-primary px-6 py-12 text-white sm:px-12 sm:py-16 dark:bg-teal-950', 'aria-labelledby': 'explore' },
            h('h2', { id: 'explore', class: sectionTitle }, text('explore')),
            h('ol', { class: 'mt-8 grid gap-8 md:grid-cols-3' }, ...[1, 2, 3].map(step => h('li', { class: 'space-y-3' },
              h('span', { class: 'inline-flex h-11 w-11 items-center justify-center rounded-full bg-white text-lg font-bold text-teal-900', 'aria-hidden': 'true' }, step),
              h('h3', { class: 'text-lg font-semibold' }, text('step' + step + 'Title')), h('p', { class: 'text-teal-50' }, text('step' + step + 'Body'))))),
            h('div', { class: 'mt-10' }, actions(true))))),
      h('footer', { class: 'border-t border-border dark:border-gray-800' },
        h('div', { class: container + ' flex flex-wrap items-center gap-x-6 gap-y-1 py-6 text-sm' },
          ...[['/source', 'source'], [repository + '/blob/main/LICENSE', 'license'], [repository + '/blob/main/docs/self-hosting.md', 'selfHosting']].map(([href, key]) =>
            h('a', { href, class: footerLink }, text(key!))), buildLabelItem(`${footerLink} break-all`, buildLabel(undefined, source)))))).toString();
}
