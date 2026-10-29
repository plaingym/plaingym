// SPDX-License-Identifier: AGPL-3.0-only
import { jsx as h } from 'hono/jsx';
import type { Translator } from '@plaingym/shared';
import type { PublicBranding, PublicPlan, WaiverTemplate } from '@plaingym/shared/contracts';
import { button, publicLayout } from './page.js';
import { maxJoinMembers } from './join.service.js';

// Only classes already compiled into the shared public stylesheet.
const inputClass = 'block min-h-11 w-full rounded-md border border-border bg-background px-3 py-2 text-base';
const panel = 'min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6';
const link = 'inline-flex min-h-11 items-center underline';
type Values = Record<string, string | number>;
const joinText = (t: Translator) => (key: string, values?: Values) => t('public/join:' + key, values);
const money = (cents: number, currency: string, locale = 'en') => new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
export interface JoinPageInput { gym: PublicBranding; t: Translator; locale?: string }
function layout(input: JoinPageInput, title: string, content: ReturnType<typeof h>, script = false) {
  return publicLayout({ gym: input.gym, title, t: input.t, ...(input.locale ? { locale: input.locale } : {}),
    content: script ? h('div', { class: 'space-y-6' }, content, h('script', { src: '/join/client.js', defer: true })) : content });
}
function price(input: JoinPageInput, plan: PublicPlan) {
  const text = joinText(input.t);
  return [h('p', { class: 'font-semibold' }, text(plan.interval, { amount: money(plan.amountCents, plan.currency, input.locale) })),
    plan.signupFeeCents ? h('p', null, text('signupFee', { amount: money(plan.signupFeeCents, plan.currency, input.locale) })) : null,
    plan.commitmentMonths ? h('p', null, text('commitment', { months: plan.commitmentMonths })) : null];
}
/** Plans a visitor can join online, or where to turn when online joining is off. */
export function joinPlansPage(input: JoinPageInput & { plans: readonly PublicPlan[] }) {
  const text = joinText(input.t);
  const content = input.plans.length ? h('section', { class: 'space-y-4' }, h('p', null, text('plansHelp')),
    h('ul', { class: 'space-y-4' }, ...input.plans.map(plan => h('li', { class: panel }, h('h2', { class: 'text-xl font-semibold' }, plan.name),
      ...price(input, plan), h('a', { href: '/join?plan=' + plan.id, class: button }, text('choose', { plan: plan.name }))))))
    : h('section', { class: panel, role: 'status' }, h('p', null, text('noPlans')), h('a', { href: '/portal', class: link }, text('portal')));
  return layout(input, text('title'), content);
}
function field(name: string, label: string, type = 'text', required = true, autocomplete = 'off', max = 200) {
  return h('label', { for: name, class: 'block space-y-1' }, label, h('input', { id: name, name, type, required, autocomplete, maxlength: max, class: inputClass }));
}
function waiver(template: WaiverTemplate, member: number, index: number, t: Translator) {
  const text = joinText(t), prefix = `waiver-${member}-${index}`;
  return h('fieldset', { class: panel, 'data-waiver': true, 'data-template': template.id, 'data-version': template.version },
    h('legend', { class: 'text-lg font-semibold' }, template.name),
    h('input', { type: 'hidden', name: prefix + '-template', value: template.id }),
    h('input', { type: 'hidden', name: prefix + '-version', value: template.version }),
    h('p', null, text('version', { version: template.version })),
    h('div', { class: 'max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4', tabindex: 0, 'aria-label': template.name }, template.body),
    h('label', { for: prefix + '-kind', class: 'block space-y-1' }, text('signerKind'),
      h('select', { id: prefix + '-kind', name: prefix + '-kind', class: inputClass }, h('option', { value: 'self' }, text('self')), h('option', { value: 'guardian' }, text('guardian')))),
    field(prefix + '-name', text('signerName'), 'text', true, 'name'),
    field(prefix + '-relationship', text('relationship'), 'text', false, 'off', 100),
    h('p', { id: prefix + '-signature' }, text('signature')), h('p', { id: prefix + '-help' }, text('signatureHelp')),
    h('canvas', { width: 900, height: 300, class: 'block h-40 w-full touch-none rounded-lg border border-border bg-white', 'aria-labelledby': prefix + '-signature', 'aria-describedby': prefix + '-help' }),
    h('button', { type: 'button', class: button, 'data-clear-signature': true }, text('clear')),
    h('label', { for: prefix + '-image', class: 'block space-y-1' }, text('signatureFile'), h('input', { id: prefix + '-image', name: prefix + '-image', type: 'file', accept: 'image/png', class: inputClass })),
    h('label', { class: 'flex min-h-11 items-center gap-3' }, h('input', { type: 'checkbox', name: prefix + '-consent', required: true, class: 'h-6 w-6 shrink-0' }), h('span', null, text('consent'))));
}
/** The household, each person joining and every current document they sign. Works as a native multipart form. */
export function joinFormPage(input: JoinPageInput & { plan: PublicPlan; count: number; templates: readonly WaiverTemplate[] }) {
  const text = joinText(input.t), plan = input.plan;
  const counter = h('form', { method: 'get', action: '/join', class: panel },
    h('input', { type: 'hidden', name: 'plan', value: plan.id }),
    h('label', { for: 'members', class: 'block space-y-1' }, text('count'), h('select', { id: 'members', name: 'members', class: inputClass },
      ...Array.from({ length: maxJoinMembers }, (_, i) => h('option', { value: i + 1, selected: i + 1 === input.count }, i ? text('people', { count: i + 1 }) : text('person'))))),
    h('button', { type: 'submit', class: button }, text('update')));
  const people = Array.from({ length: input.count }, (_, i) => h('fieldset', { class: panel, 'data-member': i },
    h('legend', { class: 'text-lg font-semibold' }, text('member', { number: i + 1 })),
    field(`member-${i}-firstName`, text('firstName')), field(`member-${i}-lastName`, text('lastName')),
    field(`member-${i}-dateOfBirth`, text('dateOfBirth'), 'date', true, 'off', 10),
    ...input.templates.map((template, j) => waiver(template, i, j, input.t))));
  const form = h('form', { method: 'post', action: '/join', enctype: 'multipart/form-data', 'data-join-form': true, class: 'space-y-6' },
    h('input', { type: 'hidden', name: 'planId', value: plan.id }), h('input', { type: 'hidden', name: 'members', value: input.count }),
    h('fieldset', { class: panel }, h('legend', { class: 'text-lg font-semibold' }, text('contact')),
      field('contactName', text('contactName'), 'text', true, 'name'), field('email', text('email'), 'email', true, 'email', 254),
      field('phone', text('phone'), 'tel', false, 'tel', 100)),
    h('div', { hidden: true, 'aria-hidden': 'true' }, h('label', null, text('honeypot'), h('input', { name: 'honeypot', tabindex: -1, autocomplete: 'off' }))),
    ...people,
    h('p', { id: 'feedback', role: 'status', 'aria-live': 'polite', class: 'break-words' }),
    h('button', { type: 'submit', class: button }, text('submit')),
    ...['failed', 'conflict', 'signatureRequired', 'busy', 'unavailable', 'tooLarge'].map(key => h('span', { hidden: true, 'data-message': key }, text(key))));
  const summary = h('section', { class: panel }, ...price(input, plan), h('p', null, text('formHelp')), h('p', { class: 'text-sm text-muted-foreground' }, text('dueToday')));
  return layout(input, text('formTitle', { plan: plan.name }), h('div', { class: 'space-y-6' }, summary, counter, form), true);
}
export type JoinPageState = 'continue' | 'confirming' | 'welcomeEmail' | 'resent' | 'welcomePassword' | 'linked' | 'contactGym'
  | 'cancelled' | 'missing' | 'unavailable' | 'failed';
/** Every step after the form. None of these pages grants anything; actions post back to fixed join routes. */
export function joinStatusPage(input: JoinPageInput & { state: JoinPageState }) {
  const text = joinText(input.t), state = input.state;
  const action = (path: string, label: string) => h('form', { method: 'post', action: path }, h('button', { type: 'submit', class: button }, text(label)));
  const start = h('a', { href: '/join', class: link }, text('startOver'));
  const [title, body, ...next] = {
    continue: ['continueTitle', 'continueBody', h('a', { href: '/join/checkout', class: button }, text('pay'))],
    confirming: ['confirmingTitle', 'confirmingBody', h('a', { href: '/join/return', class: link }, text('checkAgain'))],
    welcomeEmail: ['welcomeTitle', 'welcomeEmail', action('/join/sign-in', 'resend')],
    resent: ['welcomeTitle', 'resent', action('/join/sign-in', 'resend')],
    welcomePassword: ['welcomeTitle', 'welcomePassword', action('/join/portal-login', 'portalLogin')],
    linked: ['welcomeTitle', 'linked', h('a', { href: '/portal', class: button }, text('portal'))],
    contactGym: ['welcomeTitle', 'contactGym', h('a', { href: '/portal', class: link }, text('portal'))],
    cancelled: ['cancelledTitle', 'cancelledBody', h('a', { href: '/join/checkout', class: button }, text('pay')), start],
    missing: ['missingTitle', 'missingBody', start],
    unavailable: ['title', 'unavailable', start],
    failed: ['title', 'failed', start],
  }[state] as [string, string, ...ReturnType<typeof h>[]];
  return layout(input, text(title), h('section', { class: panel, role: 'status' }, h('p', null, text(body)), ...next));
}
