// SPDX-License-Identifier: AGPL-3.0-only
import { jsx as h } from 'hono/jsx';
import { waiverDocumentView } from './page.js';
import type { Translator } from '@plaingym/shared';
import type { PublicBranding, PublicPlan, WaiverTemplate } from '@plaingym/shared/contracts';
import { formatMoney } from '../../core/money.js';
import { button, publicLayout } from './page.js';
import { maxJoinMembers } from '@plaingym/shared/contracts';

// The shared public stylesheet is built from the classes in every public page file, `page.ts` and `*.page.ts` (`links/styles.build.mjs`).
const inputClass = 'block min-h-11 w-full rounded-md border border-border bg-background px-3 py-2 text-base';
const panel = 'min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6';
const link = 'inline-flex min-h-11 items-center underline';
type Values = Record<string, string | number>;
const joinText = (t: Translator) => (key: string, values?: Values) => t('public/join:' + key, values);
/** Each plan interval's price strings, plain and with "+ tax", spelled out so the locale key check sees every key. */
const priceKeys = {
  monthly: { plain: 'monthly', plusTax: 'monthlyPlusTax' },
  annual: { plain: 'annual', plusTax: 'annualPlusTax' },
} as const satisfies Record<PublicPlan['interval'], { plain: string; plusTax: string }>;
const signupFeeKeys = { plain: 'signupFee', plusTax: 'signupFeePlusTax' } as const;
export interface JoinPageInput { gym: PublicBranding; t: Translator; locale?: string }
function layout(input: JoinPageInput, title: string, content: ReturnType<typeof h>, script = false, refresh = false) {
  return publicLayout({ gym: input.gym, title, t: input.t, ...(input.locale ? { locale: input.locale } : {}), ...(refresh ? { noscriptRefreshSeconds: 5 } : {}),
    content: script ? h('div', { class: 'space-y-6' }, content, h('script', { src: '/join/client.js', defer: true })) : content });
}
function price(input: JoinPageInput, plan: PublicPlan) {
  const text = joinText(input.t);
  const which = plan.plusTax ? 'plusTax' : 'plain';
  return [h('p', { class: 'font-semibold' }, text(priceKeys[plan.interval][which], { amount: formatMoney(plan.amountCents, plan.currency, input.locale) })),
    plan.trialDays ? h('p', null, text('trialDays', { days: plan.trialDays })) : null,
    plan.signupFeeCents ? h('p', null, text(signupFeeKeys[which], { amount: formatMoney(plan.signupFeeCents, plan.currency, input.locale) })) : null,
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
    waiverDocumentView(template, t, undefined, member === 0),
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
    h('button', { type: 'submit', class: button }, plan.signupFeeCents === 0 && (plan.trialDays > 0 || plan.amountCents === 0)
      ? text(plan.amountCents > 0 ? 'submitCard' : 'submitFree') : text('submit')),
    ...['failed', 'conflict', 'signatureRequired', 'busy', 'unavailable', 'tooLarge'].map(key => h('span', { hidden: true, 'data-message': key }, text(key))));
  const summary = h('section', { class: panel }, ...price(input, plan), h('p', null, text('formHelp')),
    h('p', { class: 'text-sm text-muted-foreground' }, text(plan.amountCents === 0 ? 'dueTodayFree' : plan.trialDays > 0 ? 'dueTodayTrial' : 'dueToday')));
  return layout(input, text('formTitle', { plan: plan.name }), h('div', { class: 'space-y-6' }, summary, counter, form), true);
}
export type JoinPageState = 'continue' | 'confirming' | 'welcomeEmail' | 'resent' | 'welcomePassword'
  | 'cancelled' | 'closed' | 'missing' | 'unavailable' | 'failed' | 'tooLarge' | 'manual' | 'card' | 'confirmingCard' | 'cancelledCard';
/** Every step after the form. None of these pages grants anything; actions post back to fixed join routes.
 * In a demo sandbox, `testCardHint` names the test card on the steps that lead to payment. */
export function joinStatusPage(input: JoinPageInput & { state: JoinPageState; testCardHint?: string | undefined }) {
  const text = joinText(input.t), state = input.state;
  const action = (path: string, label: string) => h('form', { method: 'post', action: path }, h('button', { type: 'submit', class: button }, text(label)));
  const start = h('a', { href: '/join', class: link }, text('startOver'));
  // The script polls /join/return and replaces this page once it settles; without it the noscript refresh in the head and this link keep working.
  const progress = h('div', { class: 'flex items-center gap-3', 'data-join-progress': true },
    h('span', { 'aria-hidden': 'true', class: 'inline-block size-6 shrink-0 animate-spin rounded-full border-4 border-border border-t-foreground motion-reduce:animate-none' }),
    h('span', null, text(state === 'confirmingCard' ? 'confirmingCardProgress' : 'confirmingProgress')));
  const stalled = h('p', { hidden: true, 'data-join-stalled': true }, text('confirmingStalled'));
  const [title, body, ...next] = {
    continue: ['continueTitle', 'continueBody', h('a', { href: '/join/checkout', class: button }, text('pay'))],
    card: ['submitCard', 'cardBody', h('a', { href: '/join/checkout', class: button }, text('saveCard'))],
    confirming: ['confirmingTitle', 'confirmingBody', progress, stalled, h('a', { href: '/join/return', class: link }, text('checkAgain'))],
    confirmingCard: ['confirmingCardTitle', 'confirmingCardBody', progress, stalled, h('a', { href: '/join/return', class: link }, text('checkAgain'))],
    manual: ['manualTitle', 'manualBody', h('a', { href: '/join/return', class: link }, text('checkAgain'))],
    welcomeEmail: ['welcomeTitle', 'welcomeEmail', action('/join/sign-in', 'resend')],
    resent: ['welcomeTitle', 'resent', action('/join/sign-in', 'resend')],
    // Password mode: no account and no password until staff confirm the person and issue a printed invitation.
    welcomePassword: ['welcomeTitle', 'welcomePassword', h('a', { href: '/portal', class: link }, text('portal'))],
    cancelled: ['cancelledTitle', 'cancelledBody', h('a', { href: '/join/checkout', class: button }, text('pay')), start],
    cancelledCard: ['cancelledCardTitle', 'cancelledCardBody', h('a', { href: '/join/checkout', class: button }, text('saveCard')), start],
    closed: ['closedTitle', 'closedBody', h('a', { href: '/portal', class: link }, text('portal'))],
    missing: ['missingTitle', 'missingBody', start],
    unavailable: ['title', 'unavailable', start],
    failed: ['title', 'failed', start],
    tooLarge: ['title', 'tooLarge', h('a', { href: '/join', class: link }, text('startOver'))],
  }[state] as [string, string, ...ReturnType<typeof h>[]];
  const waiting = state === 'confirming' || state === 'confirmingCard';
  const testCard = input.testCardHint && ['continue', 'cancelled', 'card', 'cancelledCard'].includes(state)
    ? h('p', { class: 'rounded-lg border border-border bg-muted p-3', 'data-demo-test-card': true }, input.testCardHint) : null;
  return layout(input, text(title), h('section', { class: panel, role: 'status', ...(waiting ? { 'aria-live': 'polite', 'data-join-confirming': true } : {}) },
    h('p', null, text(body)), testCard, ...next), waiting, waiting);
}
