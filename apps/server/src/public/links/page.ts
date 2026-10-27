// SPDX-License-Identifier: AGPL-3.0-only
import { jsx } from 'hono/jsx';
import type { Translator } from '@plaingym/shared';
import type { PortalSignedLinkData, WaiverTemplate } from '@plaingym/shared/contracts';
import { zonedInstant } from '@plaingym/shared/time';
import { needsGuardian } from '../../areas/waivers/snapshot.js';

const button = 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-primary px-4 py-3 text-center font-semibold text-primary-foreground disabled:opacity-50';
const input = 'block min-h-11 w-full rounded-md border border-border bg-background px-3 py-2 text-base';
const panel = 'space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6';
const h = jsx;
export interface PageInput {
  data?: PortalSignedLinkData;
  state?: 'alreadyDone' | 'unavailable' | 'cleared';
  tablet?: boolean;
  now: Date;
  timezone: string;
  locale?: string;
  t: Translator;
}
/** Server-rendered Hono JSX; dynamic terms and names are escaped as text. */
export function linkPage({ data, state, tablet = false, now, timezone, locale = 'en', t }: PageInput) {
  const text = (key: string, values?: Record<string, string | number>) => t('public/links:' + key, values);
  const title = text(state ?? data?.purpose ?? 'unavailable');
  const money = (value: number, currency: string) => new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value / 100);
  const date = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: timezone })
    .format(zonedInstant(value, '12:00', timezone, { gap: 'shift' })!);
  const notice = state ? h('section', { class: panel }, h('h1', { class: 'text-2xl font-bold' }, title), h('p', null, text(state + 'Body'))) : null;
  const card = data && (data.purpose === 'update_card' || data.purpose === 'onboarding')
    ? h('section', { class: panel }, h('h2', { class: 'text-xl font-semibold' }, text('card')),
      h('p', null, text('cardHelp')),
      data.paymentMethods.length === 0 ? h('p', null, text('noCard')) : null,
      ...data.paymentMethods.map(c => h('p', null, c.last4 ? text('savedCard', { last4: c.last4 }) : text('noCard'))),
      h('button', { type: 'button', class: button, 'data-checkout': true }, text('setupCard'))) : null;
  const invoice = data?.purpose === 'pay_invoice' ? h('section', { class: panel },
    h('h2', { class: 'text-xl font-semibold' }, text('invoice', { number: data.invoice.invoice.number })),
    h('p', null, text('due', { date: date(data.invoice.invoice.dueOn) })),
    h('dl', { class: 'space-y-3' }, ...data.invoice.lines.map(l => h('div', { class: 'flex flex-wrap justify-between gap-2' },
      h('dt', { class: 'min-w-0 break-words' }, l.description), h('dd', null, money(l.amountCents, l.currency))))),
    h('p', { class: 'text-xl font-semibold' }, text('total') + ': ' + money(data.invoice.invoice.amountCents, data.invoice.invoice.currency)),
    ['open', 'past_due'].includes(data.invoice.invoice.status)
      ? h('button', { type: 'button', class: button, 'data-checkout': true }, text('pay'))
      : h('p', null, text(['paid', 'partially_refunded', 'refunded'].includes(data.invoice.invoice.status) ? 'alreadyDoneBody' : 'paymentPending'))) : null;
  function form(member: { id: string; firstName: string; lastName: string; dateOfBirth: string | null }, template: WaiverTemplate) {
    if (!data || !('signatures' in data)) return null;
    const id = member.id + '-' + template.id;
    const signed = data.signatures.some(s => s.memberId === member.id && s.templateId === template.id);
    const guardian = needsGuardian(member.dateOfBirth, now, timezone);
    return h('section', { class: panel }, h('h3', { class: 'text-lg font-semibold' }, template.name),
      h('p', null, text('member', { name: member.firstName + ' ' + member.lastName })),
      h('p', { class: 'text-sm text-muted-foreground' }, text('version', { version: template.version })),
      h('div', { class: 'max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4', tabindex: 0, 'aria-label': template.name }, template.body),
      signed ? h('p', { class: 'font-semibold' }, text('signed')) : h('form', { 'data-waiver': true, 'data-member': member.id, 'data-template': template.id, 'data-version': template.version, class: 'space-y-4' },
        guardian ? h('p', null, text('guardian')) : null,
        h('label', { for: id + '-kind', class: 'block space-y-1' }, text('signerKind'),
          h('select', { id: id + '-kind', name: 'kind', class: input }, !guardian ? h('option', { value: 'self' }, text('self')) : null,
            h('option', { value: 'guardian' }, text('guardianOption')))),
        h('label', { for: id + '-name', class: 'block space-y-1' }, text('signerName'), h('input', { id: id + '-name', name: 'name', required: true, maxlength: 200, autocomplete: 'off', class: input })),
        h('label', { for: id + '-relationship', class: 'block space-y-1', 'data-relationship': true, hidden: !guardian }, text('relationship'),
          h('input', { id: id + '-relationship', name: 'relationship', required: guardian, maxlength: 100, autocomplete: 'off', class: input })),
        h('p', { id: id + '-signature', class: 'font-semibold' }, text('signature')),
        h('p', { id: id + '-help', class: 'text-sm text-muted-foreground' }, text('signatureHelp')),
        h('canvas', { width: 900, height: 300, class: 'block h-40 w-full touch-none rounded-lg border border-border bg-white', 'aria-labelledby': id + '-signature', 'aria-describedby': id + '-help' }),
        h('button', { type: 'button', class: button, 'data-clear-signature': true }, text('clearSignature')),
        h('label', { for: id + '-file', class: 'block space-y-1' }, text('signatureFile'), h('input', { id: id + '-file', name: 'image', type: 'file', accept: 'image/png', class: input })),
        h('label', { class: 'flex min-h-11 items-center gap-3' }, h('input', { name: 'consent', type: 'checkbox', required: true, class: 'h-6 w-6 shrink-0' }), h('span', null, text('consent'))),
        h('button', { type: 'submit', class: button }, text('sign'))));
  }
  const waiverData = data && (data.purpose === 'sign_waiver' || data.purpose === 'onboarding') ? data : null;
  const waivers = waiverData ? h('section', { class: 'space-y-4' }, h('h2', { class: 'text-xl font-semibold' }, text('waivers')),
    waiverData.templates.length === 0 ? h('p', null, text('noWaivers')) : null,
    ...(waiverData.purpose === 'sign_waiver' ? [waiverData.member] : waiverData.members).flatMap(m => waiverData.templates.map(template => form(m, template)))) : null;
  return '<!doctype html>' + h('html', { lang: locale },
    h('head', null, h('meta', { charset: 'utf-8' }), h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      h('meta', { name: 'robots', content: 'noindex, nofollow' }), h('title', null, title), h('link', { rel: 'stylesheet', href: '/l/styles.css' }),
      data || (tablet && state === 'alreadyDone') ? h('script', { src: '/l/client.js', defer: true }) : null),
    h('body', { class: 'm-0 bg-background text-foreground', 'data-state': state ?? '', 'data-purpose': data?.purpose ?? '', 'data-tablet': String(tablet) },
      h('main', { class: 'mx-auto w-full max-w-2xl space-y-6 px-4 py-6 sm:px-6 sm:py-10' },
        tablet ? h('aside', { class: panel }, h('p', { class: 'font-semibold' }, text('tablet')), h('p', null, text('tabletHelp')),
          h('a', { class: button, href: '/l/cleared', 'data-exit': true }, text('clear'))) : null,
        notice ?? h('header', { class: 'space-y-2' }, h('h1', { class: 'text-2xl font-bold sm:text-3xl' }, title), h('p', null, text('welcome'))),
        h('p', { id: 'feedback', role: 'status', 'aria-live': 'polite', class: 'break-words' }), invoice, card, waivers,
        data && data.purpose !== 'sign_waiver' ? h('button', { type: 'button', class: button, 'data-complete': true }, text('checkCompletion')) : null,
        data ? h('noscript', null, text('javascript')) : null,
        h('footer', { class: 'block' }, h('a', { href: '/source', rel: 'noreferrer', class: 'inline-flex min-h-11 items-center underline' }, text('source')))),
      ...['failed', 'conflict', 'customerMissing', 'busy', 'confirming', 'signatureRequired', 'incomplete', 'done', 'doneBody'].map(key => h('span', { hidden: true, 'data-message': key }, text(key))))).toString();
}
