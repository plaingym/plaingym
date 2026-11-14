// SPDX-License-Identifier: AGPL-3.0-only
import { jsx as h } from 'hono/jsx';
import { shortHash } from '../../public/short-hash.js';
import type { Translator } from '@plaingym/shared';
import { formatMoney } from '../../core/money.js';
import type { Site, SiteClass, SitePlan, SiteSession } from './service.js';

// The shared public stylesheet is built from the classes in every public page file, including this one
// (`public/links/styles.build.mjs`). Write class names out in full: a class assembled at runtime won't compile.
type Node = ReturnType<typeof h>;
export type SitePage = 'home' | 'programs' | 'schedule' | 'plans' | 'coaches' | 'contact';
export const sitePages: readonly SitePage[] = ['home', 'programs', 'schedule', 'plans', 'coaches', 'contact'];
export const pagePath = (page: SitePage) => page === 'home' ? '/' : '/' + page;
const primaryButton = 'inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 py-3 text-center font-semibold text-primary-foreground no-underline';
const outlineButton = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-background px-5 py-3 text-center font-semibold text-foreground no-underline';
const card = 'min-w-0 rounded-xl border border-border bg-card p-4 text-card-foreground sm:p-6';
const heading = 'text-xl font-bold sm:text-2xl';

export interface SitePageInput {
  readonly page: SitePage;
  readonly site: Site;
  readonly t: Translator;
  /** The gym's canonical origin, for canonical links, Open Graph and structured data. */
  readonly origin: string;
  /** The response's CSP nonce, for the structured-data block. */
  readonly nonce: string;
  readonly locale?: string;
}
const textFor = (t: Translator) => (key: string, values?: Record<string, string | number>) => t('website/site:' + key, values);

/** `HH:MM` wall time in the gym's own zone, as written; formatting only, no conversion between zones. */
export function wallTime(localStartTime: string, offsetMinutes: number, locale = 'en') {
  const [hours, minutes] = localStartTime.split(':').map(Number) as [number, number];
  const at = Date.UTC(2000, 0, 1, hours, minutes + offsetMinutes);
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(at);
}
/** Weekday 0 is Sunday (2023-01-01 was one). */
export const weekdayName = (weekday: number, locale = 'en') =>
  new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2023, 0, 1 + weekday));
const addressLines = (address: Site['gym']['address']) => [address.line1, address.line2,
  [address.city, address.region, address.postalCode].filter(Boolean).join(', '), address.country].filter((line): line is string => !!line && !!line.trim());
const photoUrl = (id: string) => '/website/photos/' + id;
/** Versioned by the logo file, so the address survives settings saves (search engines and open pages keep it). */
const logoUrl = (site: Site) => '/public/pages/logo/' + site.gym.logoVersion;

/** Structured data for search engines: the gym as a schema.org `LocalBusiness`. */
export function localBusiness(site: Site, origin: string) {
  const address = site.gym.address, street = [address.line1, address.line2].filter(Boolean).join(', ');
  const postal = Object.fromEntries(Object.entries({ streetAddress: street, addressLocality: address.city, addressRegion: address.region,
    postalCode: address.postalCode, addressCountry: address.country }).filter(([, value]) => value));
  const description = site.content.tagline ?? site.content.about?.slice(0, 300);
  return {
    '@context': 'https://schema.org', '@type': 'LocalBusiness', name: site.gym.name, url: origin + '/',
    ...(description ? { description } : {}),
    ...(site.content.phone ? { telephone: site.content.phone } : {}), ...(site.content.email ? { email: site.content.email } : {}),
    ...(site.gym.logoVersion ? { logo: origin + logoUrl(site) } : {}),
    ...(site.content.photos.length ? { image: site.content.photos.map((photo) => origin + photoUrl(photo.id)) } : {}),
    ...(Object.keys(postal).length ? { address: { '@type': 'PostalAddress', ...postal } } : {}),
  };
}
/** JSON for an inline data block: nothing in it can close the script element or start markup. */
export const scriptJson = (value: unknown) => JSON.stringify(value)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function describe(input: SitePageInput) {
  const text = textFor(input.t), { content, gym } = input.site;
  const fallback = text('description.' + input.page, { gym: gym.name });
  if (input.page !== 'home') return fallback;
  const about = content.about?.replace(/\s+/g, ' ').trim();
  return content.tagline ?? (about ? (about.length > 160 ? about.slice(0, 157).trimEnd() + '…' : about) : fallback);
}

function navigation(input: SitePageInput, label: string, listClass: string, linkClass: string) {
  const text = textFor(input.t);
  return h('nav', { 'aria-label': label }, h('ul', { class: listClass }, ...sitePages.map((page) =>
    h('li', null, h('a', page === input.page ? { href: pagePath(page), class: linkClass + ' font-bold underline', 'aria-current': 'page' }
      : { href: pagePath(page), class: linkClass }, text('nav.' + page))))));
}

function layout(input: SitePageInput, content: Node) {
  const text = textFor(input.t), { site, origin } = input, title = input.page === 'home' ? site.gym.name : text('nav.' + input.page) + ' · ' + site.gym.name;
  const description = describe(input), url = origin + pagePath(input.page), image = site.content.photos[0];
  const structured = input.page === 'home' || input.page === 'contact';
  // Tailwind's base styles drop link underlines; the current page's link gets one back.
  const navLink = 'flex min-h-11 items-center rounded-md px-3 hover:bg-muted';
  const lines = addressLines(site.gym.address);
  return '<!doctype html>' + h('html', { lang: input.locale ?? 'en' },
    h('head', null, h('meta', { charset: 'utf-8' }), h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      h('title', null, title), h('meta', { name: 'description', content: description }),
      h('link', { rel: 'canonical', href: url }),
      h('meta', { property: 'og:type', content: 'website' }), h('meta', { property: 'og:site_name', content: site.gym.name }),
      h('meta', { property: 'og:title', content: title }), h('meta', { property: 'og:description', content: description }),
      h('meta', { property: 'og:url', content: url }),
      image ? h('meta', { property: 'og:image', content: origin + photoUrl(image.id) }) : null,
      h('link', { rel: 'stylesheet', href: '/public/pages/styles.css' }), h('link', { rel: 'stylesheet', href: '/website/theme.css?v=' + siteThemeVersion(site.gym.primaryColor, site.content.accentColor) }),
      structured ? h('script', { type: 'application/ld+json', nonce: input.nonce, dangerouslySetInnerHTML: { __html: scriptJson(localBusiness(site, origin)) } }) : null),
    h('body', { class: 'm-0 flex min-h-dvh flex-col bg-background text-foreground' },
      h('a', { href: '#main', class: 'sr-only focus:not-sr-only focus:block focus:p-3' }, text('skip')),
      h('header', { class: 'relative border-b border-border bg-background' },
        h('div', { class: 'mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-2 sm:px-6' },
          h('a', { href: '/', class: 'flex min-h-11 min-w-0 items-center gap-3 font-bold no-underline' },
            site.gym.logoVersion ? h('img', { src: logoUrl(site), alt: '', width: 40, height: 40, class: 'h-10 w-10 shrink-0 object-contain' }) : null,
            h('span', { class: 'min-w-0 break-words' }, site.gym.name)),
          h('div', { class: 'hidden items-center gap-2 lg:flex' },
            navigation(input, text('nav.label'), 'flex flex-wrap items-center gap-1', navLink),
            h('a', { href: '/portal', class: primaryButton }, text('signIn'))),
          // Without script: the menu is a disclosure that opens below the header on phones and tablets.
          h('details', { class: 'shrink-0 lg:hidden' },
            h('summary', { class: 'flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded-md border border-border px-4 font-medium' }, text('menu')),
            h('div', { class: 'absolute inset-x-0 top-full z-10 space-y-2 border-b border-border bg-background px-4 py-3 shadow-md' },
              navigation(input, text('nav.label'), 'grid gap-1', navLink),
              h('a', { href: '/portal', class: primaryButton + ' w-full' }, text('signIn')))))),
      h('main', { id: 'main', class: 'mx-auto w-full max-w-5xl flex-1 space-y-10 px-4 py-8 sm:px-6 sm:py-12' }, content),
      h('footer', { class: 'bg-secondary text-secondary-foreground' },
        h('div', { class: 'mx-auto grid w-full max-w-5xl gap-6 px-4 py-8 sm:grid-cols-2 sm:px-6' },
          h('div', { class: 'min-w-0 space-y-1' }, h('p', { class: 'break-words font-semibold' }, site.gym.name),
            ...lines.map((line) => h('p', { class: 'break-words' }, line)),
            site.content.phone ? h('p', null, h('a', { href: 'tel:' + site.content.phone.replace(/[^+\d]/g, ''), class: 'inline-flex min-h-11 items-center underline' }, site.content.phone)) : null,
            site.content.email ? h('p', { class: 'break-all' }, h('a', { href: 'mailto:' + site.content.email, class: 'inline-flex min-h-11 items-center underline' }, site.content.email)) : null),
          h('nav', { 'aria-label': text('footer.label') }, h('ul', { class: 'flex flex-wrap gap-x-4' },
            ...[['/trial', 'trial'], ['/drop-in', 'dropIn'], ['/join', 'join'], ['/portal', 'signIn'], ['/source', 'source']].map(([href, key]) =>
              h('li', null, h('a', { href, class: 'inline-flex min-h-11 items-center underline' }, text(key!)))))))))).toString();
}

function calls(t: Translator, extra = false) {
  const text = textFor(t);
  return h('div', { class: 'flex flex-col gap-3 sm:flex-row sm:flex-wrap' },
    h('a', { href: '/trial', class: primaryButton }, text('trial')),
    h('a', { href: '/join', class: outlineButton }, text('join')),
    extra ? h('a', { href: '/drop-in', class: outlineButton }, text('dropIn')) : null);
}
const section = (title: string, ...children: (Node | null)[]) => h('section', { class: 'space-y-4' }, h('h2', { class: heading }, title), ...children);
const empty = (message: string) => h('p', { class: card }, message);

type Line = Pick<SiteClass, 'name' | 'localStartTime' | 'durationMinutes' | 'kind' | 'coach' | 'programIds'>;
/** A date as a heading, such as "Wednesday, Nov 4"; `date` is a calendar date, so the zone is fixed. */
const dateHeading = (date: string, locale = 'en') =>
  new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.parse(date + 'T00:00:00Z'));
function classLine(item: Line, input: SitePageInput, programNames: ReadonlyMap<string, string>, day: number | null, change?: SiteSession['change']) {
  const text = textFor(input.t), locale = input.locale;
  const time = text('timeRange', { start: wallTime(item.localStartTime, 0, locale), end: wallTime(item.localStartTime, item.durationMinutes, locale) });
  const names = item.programIds.map((id) => programNames.get(id)).filter((name): name is string => !!name);
  return h('li', { class: 'min-w-0 space-y-1 border-t border-border py-3 first:border-t-0' },
    h('p', { class: 'font-semibold' }, day !== null ? text('dayTime', { day: weekdayName(day, locale), time }) : time),
    h('p', { class: change === 'cancelled' ? 'break-words line-through' : 'break-words' }, item.name,
      change ? h('span', { class: 'ml-2 rounded bg-muted px-2 py-0.5 text-sm font-semibold' }, text('change.' + change)) : null,
      item.kind === 'open_mat' ? h('span', { class: 'ml-2 rounded bg-muted px-2 py-0.5 text-sm' }, text('openMat')) : null),
    item.coach ? h('p', { class: 'break-words text-muted-foreground' }, text('coach', { name: item.coach })) : null,
    names.length ? h('p', { class: 'break-words text-sm text-muted-foreground' }, names.join(' · ')) : null);
}

function home(input: SitePageInput) {
  const text = textFor(input.t), { site } = input, [hero, ...gallery] = site.content.photos;
  const lines = addressLines(site.gym.address);
  return [
    h('section', { class: 'grid items-center gap-6 md:grid-cols-2' },
      h('div', { class: 'min-w-0 space-y-4' },
        h('h1', { class: 'break-words text-3xl font-bold sm:text-4xl' }, site.gym.name),
        site.content.tagline ? h('p', { class: 'break-words text-lg text-muted-foreground' }, site.content.tagline) : null,
        calls(input.t), h('p', null, h('a', { href: '/portal', class: 'inline-flex min-h-11 items-center underline' }, text('memberSignIn')))),
      hero ? h('img', { src: photoUrl(hero.id), alt: hero.alt, width: 800, height: 600, class: 'aspect-[4/3] h-auto w-full rounded-xl object-cover' }) : null),
    site.content.about ? section(text('about'), h('p', { class: 'whitespace-pre-line break-words' }, site.content.about)) : null,
    site.programs.length ? section(text('nav.programs'),
      h('ul', { class: 'flex flex-wrap gap-2' }, ...site.programs.map((program) =>
        h('li', { class: 'break-words rounded-full bg-secondary px-4 py-2 text-secondary-foreground' }, program.name))),
      h('p', null, h('a', { href: '/schedule', class: 'inline-flex min-h-11 items-center underline' }, text('seeSchedule')))) : null,
    gallery.length ? section(text('photos'), h('ul', { class: 'grid grid-cols-2 gap-3 sm:grid-cols-3' }, ...gallery.map((photo) =>
      h('li', { class: 'min-w-0' }, h('img', { src: photoUrl(photo.id), alt: photo.alt, width: 400, height: 300, loading: 'lazy', class: 'aspect-[4/3] h-auto w-full rounded-lg object-cover' }))))) : null,
    lines.length ? section(text('visit'), h('address', { class: 'not-italic' }, ...lines.map((line) => h('p', { class: 'break-words' }, line))),
      h('p', null, h('a', { href: '/contact', class: 'inline-flex min-h-11 items-center underline' }, text('directions')))) : null,
  ];
}
function programsPage(input: SitePageInput) {
  const text = textFor(input.t), { site } = input, names = new Map(site.programs.map((program) => [program.id, program.name]));
  return [h('h1', { class: 'text-3xl font-bold' }, text('nav.programs')), h('p', null, text('programsIntro')),
    site.programs.length ? h('ul', { class: 'grid gap-4 md:grid-cols-2' }, ...site.programs.map((program) => {
      const classes = site.classes.filter((item) => item.programIds.includes(program.id));
      return h('li', { class: card + ' space-y-2' }, h('h2', { class: 'break-words text-xl font-semibold' }, program.name),
        classes.length ? h('ul', null, ...classes.map((item) => classLine(item, input, names, item.weekday))) : h('p', { class: 'text-muted-foreground' }, text('noProgramClasses')));
    })) : empty(text('noPrograms')), calls(input.t)];
}
/** This week's cancelled, one-off and moved sessions by date, or nothing when the week runs as the timetable says. */
function weekChanges(input: SitePageInput, names: ReadonlyMap<string, string>) {
  const text = textFor(input.t), { sessions } = input.site;
  if (!sessions.length) return null;
  const dates = [...new Set(sessions.map((session) => session.date))];
  return section(text('thisWeek'), h('p', null, text('thisWeekIntro')),
    h('div', { class: 'grid gap-4 md:grid-cols-2 lg:grid-cols-3' }, ...dates.map((date) =>
      h('section', { class: card }, h('h3', { class: 'text-lg font-semibold' }, dateHeading(date, input.locale)),
        h('ul', null, ...sessions.filter((session) => session.date === date).map((session) => classLine(session, input, names, null, session.change)))))));
}
function schedulePage(input: SitePageInput) {
  const text = textFor(input.t), { site } = input, names = new Map(site.programs.map((program) => [program.id, program.name]));
  const days = [...new Set(site.classes.map((item) => item.weekday))];
  return [h('h1', { class: 'text-3xl font-bold' }, text('nav.schedule')),
    h('p', null, text('scheduleIntro', { timezone: site.gym.timezone })),
    days.length ? h('div', { class: 'grid gap-4 md:grid-cols-2 lg:grid-cols-3' }, ...days.map((day) =>
      h('section', { class: card }, h('h2', { class: 'text-lg font-semibold' }, weekdayName(day, input.locale)),
        h('ul', null, ...site.classes.filter((item) => item.weekday === day).map((item) => classLine(item, input, names, null))))))
      : empty(text('noClasses')),
    weekChanges(input, names),
    h('p', null, text('bookInPortal'), ' ', h('a', { href: '/portal', class: 'inline-flex min-h-11 items-center underline' }, text('memberSignIn'))), calls(input.t)];
}
function planLine(plan: SitePlan, input: SitePageInput) {
  const text = textFor(input.t), money = (cents: number) => formatMoney(cents, plan.currency, input.locale);
  const price = text(plan.interval === 'annual' ? 'perYear' : 'perMonth', { amount: money(plan.amountCents) });
  return h('li', { class: card + ' space-y-2' }, h('h2', { class: 'break-words text-xl font-semibold' }, plan.name),
    h('p', { class: 'text-2xl font-bold' }, plan.plusTax ? text('plusTax', { price }) : price),
    plan.trialDays ? h('p', null, text('trialDays', { days: plan.trialDays })) : null,
    plan.signupFeeCents ? h('p', null, text('signupFee', { amount: money(plan.signupFeeCents) })) : null,
    plan.commitmentMonths ? h('p', null, text('commitment', { months: plan.commitmentMonths })) : null);
}
function plansPage(input: SitePageInput) {
  const text = textFor(input.t), { site } = input;
  return [h('h1', { class: 'text-3xl font-bold' }, text('nav.plans')), h('p', null, text('plansIntro')),
    site.plans.length ? h('ul', { class: 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3' }, ...site.plans.map((plan) => planLine(plan, input))) : empty(text('noPlans')),
    calls(input.t, true)];
}
function coachesPage(input: SitePageInput) {
  const text = textFor(input.t), { site } = input;
  return [h('h1', { class: 'text-3xl font-bold' }, text('nav.coaches')),
    site.coaches.length ? h('ul', { class: 'grid gap-4 md:grid-cols-2' }, ...site.coaches.map((coach) =>
      h('li', { class: card + ' flex min-w-0 flex-col gap-4 sm:flex-row' },
        coach.photo ? h('img', { src: '/website/coaches/' + coach.id + '/photo', alt: '', width: 96, height: 96, loading: 'lazy', class: 'h-24 w-24 shrink-0 rounded-full object-cover' }) : null,
        h('div', { class: 'min-w-0 space-y-2' }, h('h2', { class: 'break-words text-xl font-semibold' }, coach.displayName),
          coach.rank ? h('p', { class: 'break-words text-muted-foreground' }, coach.rank) : null,
          coach.bio ? h('p', { class: 'whitespace-pre-line break-words' }, coach.bio) : null)))) : empty(text('noCoaches')),
    calls(input.t)];
}
function contactPage(input: SitePageInput) {
  const text = textFor(input.t), { site } = input, lines = addressLines(site.gym.address), { phone, email } = site.content;
  const map = lines.length ? 'https://www.openstreetmap.org/search?query=' + encodeURIComponent(lines.join(', ')) : null;
  return [h('h1', { class: 'text-3xl font-bold' }, text('nav.contact')),
    h('div', { class: 'grid gap-4 md:grid-cols-2' },
      h('section', { class: card + ' space-y-2' }, h('h2', { class: 'text-xl font-semibold' }, text('location')),
        lines.length ? h('address', { class: 'not-italic' }, ...lines.map((line) => h('p', { class: 'break-words' }, line))) : h('p', null, text('noAddress')),
        map ? h('p', null, h('a', { href: map, rel: 'noreferrer', class: 'inline-flex min-h-11 items-center underline' }, text('openMap'))) : null),
      h('section', { class: card + ' space-y-2' }, h('h2', { class: 'text-xl font-semibold' }, text('contact')),
        phone ? h('p', { class: 'break-all' }, h('a', { href: 'tel:' + phone.replace(/[^+\d]/g, ''), class: 'inline-flex min-h-11 items-center underline' }, text('phone', { phone }))) : null,
        email ? h('p', { class: 'break-all' }, h('a', { href: 'mailto:' + email, class: 'inline-flex min-h-11 items-center underline' }, text('email', { email }))) : null,
        !phone || !email ? h('p', null, text('noContact')) : null)),
    calls(input.t, true)];
}
const pages: Record<SitePage, (input: SitePageInput) => (Node | null)[]> = {
  home, programs: programsPage, schedule: schedulePage, plans: plansPage, coaches: coachesPage, contact: contactPage,
};
/** One website page as a complete HTML document. Every gym-supplied string is escaped by the JSX renderer. */
export function renderSitePage(input: SitePageInput): string {
  return layout(input, h('div', { class: 'space-y-8' }, ...pages[input.page](input)));
}

/** Hash the rendered colors so restoring an older settings revision cannot reuse a different theme's URL. */
export const siteThemeVersion = (primary: string | null, accent: string | null) =>
  shortHash(siteThemeCss(primary, accent));

/** Validated colors only: nothing a gym types can reach the stylesheet except a `#rrggbb` value. */
export function siteThemeCss(primary: string | null, accent: string | null) {
  const valid = (color: string | null): color is string => !!color && /^#[0-9a-f]{6}$/i.test(color);
  const foreground = (color: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) as [number, number, number];
    return r * 0.2126 + g * 0.7152 + b * 0.0722 > 0.179 ? '#000000' : '#ffffff';
  };
  const rules = [...valid(primary) ? [`--color-primary:${primary}`, `--color-primary-foreground:${foreground(primary)}`] : [],
    ...valid(accent) ? [`--color-secondary:${accent}`, `--color-secondary-foreground:${foreground(accent)}`] : []];
  return rules.length ? `:root{${rules.join(';')}}` : '';
}
