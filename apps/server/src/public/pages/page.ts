// SPDX-License-Identifier: AGPL-3.0-only
import { jsx as h } from 'hono/jsx';
import type { Translator } from '@plaingym/shared';
import type { PublicBranding, WaiverTemplate } from '@plaingym/shared/contracts';

export const button = 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-primary px-4 py-3 text-center font-semibold text-primary-foreground disabled:opacity-50';
const inputClass = 'block min-h-11 w-full rounded-md border border-border bg-background px-3 py-2 text-base';
const panel = 'min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6';
export const pageText = (t: Translator) => (key: string, values?: Record<string, string | number>) => t('public/pages:' + key, values);
/** Shared server-rendered shell for the gym's core public pages. */
export function publicLayout(input: { gym: PublicBranding; title: string; t: Translator; content: ReturnType<typeof h>; locale?: string; script?: boolean }) {
  const text = pageText(input.t);
  return '<!doctype html>' + h('html', { lang: input.locale ?? 'en' },
    h('head', null, h('meta', { charset: 'utf-8' }), h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      h('meta', { name: 'robots', content: 'noindex, nofollow' }), h('title', null, input.title + ' · ' + input.gym.name),
      h('link', { rel: 'stylesheet', href: '/public/pages/styles.css' }), h('link', { rel: 'stylesheet', href: '/public/pages/theme.css' }),
      input.script ? h('script', { src: '/public/pages/client.js', defer: true }) : null),
    h('body', { class: 'm-0 bg-background text-foreground' },
      h('main', { class: 'mx-auto w-full max-w-2xl space-y-6 px-4 py-6 sm:px-6 sm:py-10' },
        h('header', { class: 'space-y-2' }, input.gym.logoKey ? h('img', { src: '/public/pages/logo', alt: input.gym.name, width: 64, height: 64 }) : null,
          h('p', { class: 'break-words font-semibold' }, input.gym.name), h('h1', { class: 'text-2xl font-bold sm:text-3xl' }, input.title)),
        input.content,
        h('footer', { class: 'flex flex-wrap gap-3' },
          ...[['/trial', 'trial'], ['/drop-in', 'drop-in'], ['/portal', 'portal'], ['/source', 'source']].map(([href, key]) =>
            h('a', { href, class: 'inline-flex min-h-11 items-center underline', rel: 'noreferrer' }, text(key!))))))).toString();
}
export interface IntakePageInput {
  kind: 'trial' | 'drop-in'; gym: PublicBranding; t: Translator; templates?: WaiverTemplate[];
  dropInFee: { amountCents: number; currency: string } | null; locale?: string;
  state?: 'received' | 'failed' | 'unavailable';
}
export function intakePage(input: IntakePageInput) {
  const text = pageText(input.t), title = text(input.state === 'received' ? 'received' : input.kind);
  const field = (name: string, label: string, type = 'text', required = true, autocomplete = 'off', max = 200) =>
    h('label', { for: name, class: 'block space-y-1' }, text(label),
      h('input', { id: name, name, type, required, autocomplete, maxlength: max, class: inputClass }));
  const fee = input.kind === 'drop-in' ? h('p', { class: 'font-semibold' }, input.dropInFee
    ? text('fee', { amount: new Intl.NumberFormat(input.locale ?? 'en', { style: 'currency', currency: input.dropInFee.currency }).format(input.dropInFee.amountCents / 100) }) : text('feeUnknown')) : null;
  const content = h('section', { class: 'space-y-4' }, fee,
    input.state ? h('section', { class: panel, role: 'status' }, h('p', null, text(input.state === 'received' ? 'receivedBody' : input.state)))
      : h('form', { method: 'post', action: '/' + input.kind, enctype: input.kind === 'drop-in' ? 'multipart/form-data' : 'application/x-www-form-urlencoded',
        'data-public-form': input.kind, class: panel },
        h('p', null, text(input.kind === 'trial' ? 'trialHelp' : 'drop-inHelp')),
        field('firstName', 'firstName', 'text', true, 'given-name'), field('lastName', 'lastName', 'text', true, 'family-name'),
        field('dateOfBirth', 'dateOfBirth', 'date', true, 'bday'), field('contactName', 'contactName', 'text', true, 'name'),
        field('email', 'email', 'email', true, 'email', 254), field('phone', 'phone', 'tel', false, 'tel', 100),
        h('div', { hidden: true, 'aria-hidden': 'true' }, h('label', null, text('honeypot'), h('input', { name: 'honeypot', tabindex: -1, autocomplete: 'off' }))),
        ...(input.templates ?? []).map((template, i) => waiverForm(template, i, input.t)),
        h('p', { id: 'feedback', role: 'status', 'aria-live': 'polite', class: 'break-words' }),
        h('button', { type: 'submit', class: button }, text('submit')),
        ...['failed', 'conflict', 'signatureRequired', 'busy'].map(key => h('span', { hidden: true, 'data-message': key }, text(key)))));
  return publicLayout({ gym: input.gym, title, t: input.t, content, ...(input.locale ? { locale: input.locale } : {}), script: !input.state });
}
function waiverForm(template: WaiverTemplate, i: number, t: Translator) {
  const text = pageText(t), prefix = 'waiver-' + i;
  return h('fieldset', { class: panel, 'data-waiver': true, 'data-template': template.id, 'data-version': template.version },
    h('legend', { class: 'text-lg font-semibold' }, template.name),
    h('input', { type: 'hidden', name: prefix + '-template', value: template.id }),
    h('input', { type: 'hidden', name: prefix + '-version', value: template.version }),
    h('p', null, text('version', { version: template.version })),
    h('div', { class: 'max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4', tabindex: 0, 'aria-label': template.name }, template.body),
    h('p', null, text('guardianHelp')),
    h('label', { for: prefix + '-kind', class: 'block space-y-1' }, text('signerKind'),
      h('select', { id: prefix + '-kind', name: prefix + '-kind', class: inputClass }, h('option', { value: 'self' }, text('self')), h('option', { value: 'guardian' }, text('guardian')))),
    h('label', { for: prefix + '-name', class: 'block space-y-1' }, text('signerName'), h('input', { id: prefix + '-name', name: prefix + '-name', required: true, maxlength: 200, class: inputClass })),
    h('label', { for: prefix + '-relationship', class: 'block space-y-1' }, text('relationship'), h('input', { id: prefix + '-relationship', name: prefix + '-relationship', maxlength: 100, class: inputClass })),
    h('p', { id: prefix + '-signature' }, text('signature')), h('p', { id: prefix + '-help' }, text('signatureHelp')),
    h('canvas', { width: 900, height: 300, class: 'block h-40 w-full touch-none rounded-lg border border-border bg-white', 'aria-labelledby': prefix + '-signature', 'aria-describedby': prefix + '-help' }),
    h('button', { type: 'button', class: button, 'data-clear-signature': true }, text('clear')),
    h('label', { for: prefix + '-image', class: 'block space-y-1' }, text('signatureFile'), h('input', { id: prefix + '-image', name: prefix + '-image', type: 'file', accept: 'image/png', class: inputClass })),
    h('label', { class: 'flex min-h-11 items-center gap-3' }, h('input', { type: 'checkbox', name: prefix + '-consent', required: true, class: 'h-6 w-6 shrink-0' }), h('span', null, text('consent'))));
}

/** Strict external stylesheet: only validated color tokens can enter CSS. */
export function themeCss(primary: string | null) {
  if (!primary || !/^#[0-9a-f]{6}$/i.test(primary)) return '';
  const rgb = [1, 3, 5].map(i => parseInt(primary.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  return `:root{--color-primary:${primary};--color-primary-foreground:${luminance > 0.179 ? '#000000' : '#ffffff'}}`;
}
