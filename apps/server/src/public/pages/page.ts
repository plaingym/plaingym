// SPDX-License-Identifier: AGPL-3.0-only
import { jsx as h } from 'hono/jsx';
import type { Translator } from '@plaingym/shared';
import type { PublicBranding, WaiverTemplate } from '@plaingym/shared/contracts';
import { formatMoney } from '../../core/money.js';
import { buildLabel, buildLabelItem } from '../../areas/health/build-label.js';
import { logoVersion } from '../short-hash.js';
import { callingCode, internationalPrefix, keepsInternationalPrefix, phoneCountryOptions } from '@plaingym/shared/phone-countries';
/** Native browser preview and a separate link also work without JavaScript. */
export function waiverDocumentView(template: WaiverTemplate, t: Translator, href = `/api/public/waivers/${template.id}/document?view=1`, preview = true) {
  if (!template.document) return h('div', { class: 'max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4', tabindex: 0, 'aria-label': template.name }, template.body);
  return h('div', { class: 'min-w-0 space-y-2' },
    preview ? h('iframe', { src: href, title: template.name, class: 'h-96 w-full rounded-lg border border-border', referrerpolicy: 'no-referrer' }) : null,
    h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'inline-flex min-h-11 items-center break-words underline' }, t('waivers/waivers:openDocument')),
    h('p', { class: 'text-sm' }, t('waivers/waivers:documentHelp')));
}

/** The public pages' own policy (`/trial`, `/drop-in`, `/join`): script, styles and images from the app only. */
export const publicPageDirectives = ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "img-src 'self'", "base-uri 'none'",
  "form-action 'self'", "frame-src 'self'", "frame-ancestors 'none'"];
export const buttonControl = 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-center font-semibold disabled:opacity-50 transition-colors motion-reduce:transition-none';
const buttonFocus = 'outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring dark:focus-visible:outline-teal-300';
export const button = `${buttonControl} ${buttonFocus} bg-primary px-4 py-3 text-primary-foreground hover:not-disabled:bg-primary/90 active:not-disabled:bg-primary/80`;
export const secondaryButton = `${buttonControl} ${buttonFocus} border border-border bg-background px-4 py-3 text-foreground hover:not-disabled:bg-muted active:not-disabled:bg-secondary`;
/** Shared with other server-rendered pages (the staff invitation): this file's classes are the ones the public stylesheet holds. */
export const inputClass = 'block min-h-11 w-full rounded-md border border-border bg-background px-3 py-2 text-base';
export const panel = 'min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6';
export const pageText = (t: Translator) => (key: string, values?: Record<string, string | number>) => t('public/pages:' + key, values);
export const addressLines = (address: PublicBranding['address'] = {}) => [address.line1, address.line2,
  [address.city, address.region, address.postalCode].filter(Boolean).join(', '), address.country]
  .filter((line): line is string => !!line?.trim());
export const telephoneHref = (phone: string) => 'tel:' + phone.replace(/[^+\d]/g, '');
export const gymLogo = (key: string, name: string) => h('img', {
  src: '/public/pages/logo/' + logoVersion(key), alt: name, width: 64, height: 64,
  class: 'h-16 w-16 rounded-lg bg-white object-contain p-1',
});
/** Public contact details also remain available with the website turned off. */
export function contactBlock(gym: PublicBranding, t: Translator) {
  const text = pageText(t), lines = addressLines(gym.address);
  return h('section', { class: panel, 'aria-label': text('contactGym') },
    h('h2', { class: 'text-xl font-semibold' }, text('contactGym')),
    lines.length ? h('address', { class: 'not-italic break-words' }, ...lines.map(line => h('p', null, line))) : null,
    gym.phone ? h('p', null, h('a', { href: telephoneHref(gym.phone), class: 'inline-flex min-h-11 items-center break-all underline' }, gym.phone)) : null,
    gym.email ? h('p', null, h('a', { href: 'mailto:' + gym.email, class: 'inline-flex min-h-11 items-center break-all underline' }, gym.email)) : null,
    !lines.length && !gym.phone && !gym.email ? h('p', null, text('contactMissing')) : null);
}
/** Shared server-rendered shell for the gym's core public pages. */
export function publicLayout(input: { gym: PublicBranding; title: string; t: Translator; content: ReturnType<typeof h>; locale?: string; script?: boolean; noscriptRefreshSeconds?: number }) {
  const text = pageText(input.t);
  return '<!doctype html>' + h('html', { lang: input.locale ?? 'en', class: 'theme-system' },
    h('head', null, h('meta', { charset: 'utf-8' }), h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      h('meta', { name: 'color-scheme', content: 'light dark' }),
      h('meta', { name: 'robots', content: 'noindex, nofollow' }), h('title', null, input.title + ' · ' + input.gym.name),
      h('link', { rel: 'stylesheet', href: '/public/pages/styles.css' }), h('link', { rel: 'stylesheet', href: '/public/pages/theme.css' }),
      input.noscriptRefreshSeconds ? h('noscript', null, h('meta', { 'http-equiv': 'refresh', content: String(input.noscriptRefreshSeconds) })) : null,
      input.script ? h('script', { src: '/public/pages/client.js', defer: true }) : null),
    h('body', { class: 'm-0 bg-background text-foreground' },
      h('main', { class: 'mx-auto w-full max-w-2xl space-y-6 px-4 py-6 sm:px-6 sm:py-10' },
        h('header', { class: 'space-y-2' }, input.gym.logoKey ? gymLogo(input.gym.logoKey, input.gym.name) : null,
          h('p', { class: 'break-words font-semibold' }, input.gym.name), h('h1', { class: 'text-2xl font-bold sm:text-3xl' }, input.title)),
        input.content, contactBlock(input.gym, input.t),
        h('footer', { class: 'flex flex-wrap gap-3' },
          ...[['/join', 'join'], ['/trial', 'trial'], ['/drop-in', 'drop-in'], ['/portal', 'portal'], ['/source', 'source']].map(([href, key]) =>
            h('a', { href, class: 'inline-flex min-h-11 items-center underline', rel: 'noreferrer' }, text(key!))), buildLabelItem(undefined, buildLabel(undefined, undefined, input.t)))))).toString();
}
/**
 * A country code choice beside the phone number. Works without script: the form handler (or the page script) joins
 * `+<calling code> <number>` unless the number starts with +, or replaces the chosen country's international prefix
 * with + (or keeps it as typed when its prefix carries a carrier code). `selected` (a redisplayed choice, possibly empty)
 * wins over the gym's country.
 */
export function phoneField(t: Translator, options: { label: string; country?: string | null | undefined; selected?: string; value?: string }) {
  const choices = phoneCountryOptions();
  const selected = typeof options.selected === 'string' ? options.selected : callingCode(options.country) !== null ? options.country!.toUpperCase() : '';
  return h('div', { class: 'space-y-1' },
    h('label', { for: 'phoneCountry', class: 'block' }, t('shell/phone:country')),
    h('select', { id: 'phoneCountry', name: 'phoneCountry', class: inputClass },
      h('option', { value: '', selected: selected === '' }, t('shell/phone:choose')),
      ...choices.map(choice => h('option', {
        value: choice.value,
        'data-calling-code': choice.callingCode,
        'data-international-prefix': internationalPrefix(choice.callingCode),
        ...(keepsInternationalPrefix(choice.callingCode) ? { 'data-keep-prefix': 'true' } : {}),
        selected: choice.value === selected,
      }, choice.label))),
    h('label', { for: 'phone', class: 'block' }, options.label),
    h('input', { id: 'phone', name: 'phone', type: 'tel', autocomplete: 'tel', maxlength: 95, ...(options.value !== undefined ? { value: options.value } : {}), class: inputClass }));
}
export interface IntakePageInput {
  kind: 'trial' | 'drop-in'; gym: PublicBranding; t: Translator; templates?: WaiverTemplate[];
  dropInFee: { amountCents: number; currency: string; plusTax: boolean } | null; locale?: string;
  state?: 'received' | 'failed' | 'unavailable' | 'limited' | 'retry';
}
export function intakePage(input: IntakePageInput) {
  const text = pageText(input.t), title = text(input.state === 'received' ? 'received' : input.kind);
  const field = (name: string, label: string, type = 'text', required = true, autocomplete = 'off', max = 200) =>
    h('label', { for: name, class: 'block space-y-1' }, text(label),
      h('input', { id: name, name, type, required, autocomplete, maxlength: max, class: inputClass }));
  const fee = input.kind === 'drop-in' ? h('p', { class: 'font-semibold' }, input.dropInFee
    ? text(input.dropInFee.plusTax ? 'feePlusTax' : 'fee', { amount: formatMoney(input.dropInFee.amountCents, input.dropInFee.currency, input.locale) }) : text('feeUnknown')) : null;
  const content = h('section', { class: 'space-y-4' }, fee,
    input.state ? h('section', { class: panel, role: 'status' }, h('p', null, text(input.state === 'received' ? 'receivedBody' : input.state === 'limited' ? 'intakeLimited' : input.state)))
      : h('form', { method: 'post', action: '/' + input.kind, enctype: input.kind === 'drop-in' ? 'multipart/form-data' : 'application/x-www-form-urlencoded',
        'data-public-form': input.kind, class: panel },
        h('p', null, text(input.kind === 'trial' ? 'trialHelp' : 'drop-inHelp')),
        field('firstName', 'firstName', 'text', true, 'given-name'), field('lastName', 'lastName', 'text', true, 'family-name'),
        field('dateOfBirth', 'dateOfBirth', 'date', true, 'bday'), field('contactName', 'contactName', 'text', true, 'name'),
        field('email', 'email', 'email', true, 'email', 254), phoneField(input.t, { label: text('phone'), country: input.gym.address?.country }),
        h('div', { hidden: true, 'aria-hidden': 'true' }, h('label', null, text('honeypot'), h('input', { name: 'honeypot', tabindex: -1, autocomplete: 'off' }))),
        ...(input.templates ?? []).map((template, i) => waiverForm(template, i, input.t)),
        h('p', { id: 'feedback', role: 'status', 'aria-live': 'polite', class: 'break-words' }),
        h('button', { type: 'submit', class: button }, text('submit')),
        ...['failed', 'conflict', 'signatureRequired', 'busy', 'retry', 'limited', 'intakeLimited'].map(key => h('span', { hidden: true, 'data-message': key }, text(key)))));
  return publicLayout({ gym: input.gym, title, t: input.t, content, ...(input.locale ? { locale: input.locale } : {}), script: !input.state });
}
function waiverForm(template: WaiverTemplate, i: number, t: Translator) {
  const text = pageText(t), prefix = 'waiver-' + i;
  return h('fieldset', { class: panel, 'data-waiver': true, 'data-template': template.id, 'data-version': template.version },
    h('legend', { class: 'text-lg font-semibold' }, template.name),
    h('input', { type: 'hidden', name: prefix + '-template', value: template.id }),
    h('input', { type: 'hidden', name: prefix + '-version', value: template.version }),
    h('p', null, text('version', { version: template.version })),
    waiverDocumentView(template, t),
    h('p', null, text('guardianHelp')),
    h('label', { for: prefix + '-kind', class: 'block space-y-1' }, text('signerKind'),
      h('select', { id: prefix + '-kind', name: prefix + '-kind', class: inputClass }, h('option', { value: 'self' }, text('self')), h('option', { value: 'guardian' }, text('guardian')))),
    h('label', { for: prefix + '-name', class: 'block space-y-1' }, text('signerName'), h('input', { id: prefix + '-name', name: prefix + '-name', required: true, maxlength: 200, class: inputClass })),
    h('label', { for: prefix + '-relationship', class: 'block space-y-1' }, text('relationship'), h('input', { id: prefix + '-relationship', name: prefix + '-relationship', maxlength: 100, class: inputClass })),
    h('p', { id: prefix + '-signature' }, text('signature')), h('p', { id: prefix + '-help' }, text('signatureHelp')),
    h('canvas', { width: 900, height: 300, class: 'block h-40 w-full touch-none rounded-lg border border-border bg-white', 'aria-labelledby': prefix + '-signature', 'aria-describedby': prefix + '-help' }),
    h('button', { type: 'button', class: secondaryButton, 'data-clear-signature': true }, text('clear')),
    h('label', { for: prefix + '-image', class: 'block space-y-1' }, text('signatureFile'), h('input', { id: prefix + '-image', name: prefix + '-image', type: 'file', accept: 'image/png', class: inputClass })),
    h('label', { class: 'flex min-h-11 items-center gap-3' }, h('input', { type: 'checkbox', name: prefix + '-consent', required: true, class: 'h-6 w-6 shrink-0' }), h('span', null, text('consent'))));
}

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
function luminance(channels: number[]) {
  const [red, green, blue] = channels.map(channel => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
}
// Match background and card in apps/web/src/app/styles.css. The lighter surface sets the minimum.
const darkSurface = Math.max(luminance(rgb('#0c1514')), luminance(rgb('#111d1c')));
const darkTextMinimum = 4.5 * (darkSurface + 0.05) - 0.05;
const lightAccentMaximum = (luminance(rgb('#ffffff')) + 0.05) / 3 - 0.05;
const hexColor = (channels: number[]) =>
  '#' + channels.map(channel => channel.toString(16).padStart(2, '0')).join('');
const colorTokens = (color: string, brightness: number) =>
  `--color-primary:${color};--color-primary-foreground:${brightness > 0.179 ? '#000000' : '#ffffff'}`;

/** Strict external stylesheet: only validated color tokens can enter CSS. */
export function themeCss(primary: string | null) {
  if (!primary || !/^#[0-9a-f]{6}$/i.test(primary)) return '';
  const original = rgb(primary), originalLuminance = luminance(original);
  let light = originalLuminance, lightPrimary = primary;
  // Check the rounded sRGB channels that the browser will actually render.
  for (let step = 1; light > lightAccentMaximum; step++) {
    const mixed = original.map(channel => Math.round(channel * (255 - step) / 255));
    light = luminance(mixed);
    lightPrimary = hexColor(mixed);
  }
  let dark = originalLuminance, darkPrimary = primary;
  for (let step = 1; dark < darkTextMinimum; step++) {
    const mixed = original.map(channel => Math.round(channel + (255 - channel) * step / 255));
    dark = luminance(mixed);
    darkPrimary = hexColor(mixed);
  }
  const darkTokens = colorTokens(darkPrimary, dark);
  return `:root{${colorTokens(lightPrimary, light)}}@media screen{.dark{${darkTokens}}}@media screen and (prefers-color-scheme: dark){.theme-system{${darkTokens}}}`;
}
