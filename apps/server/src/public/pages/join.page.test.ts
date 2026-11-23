// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { joinFormPage, joinStatusPage, type JoinPageState } from './join.page.js';
import { phoneField } from './page.js';

const t = createTranslator(locales.en ?? {});
const gym = { name: 'Demo academy', revision: 1, logoKey: null, primaryColor: null };
const render = async (state: JoinPageState, testCardHint?: string) =>
  String(await joinStatusPage({ gym, t, state, ...(testCardHint ? { testCardHint } : {}) }));

/** The one actions row, so a second row or an unwrapped action fails the test. */
function actionsRow(html: string) {
  const rows = [...html.matchAll(/<div class="flex flex-wrap items-center gap-3" data-join-actions(?:="[^"]*")?>([\s\S]*?)<\/div>/g)];
  expect(rows).toHaveLength(1);
  return rows[0]![1]!;
}

describe('join status page cancelled actions', () => {
  it.each([
    ['cancelled', 'Pay securely'],
    ['cancelledCard', 'Save card securely'],
  ] as const)('puts the %s action and Start again in one wrapping row', async (state, label) => {
    const html = await render(state), row = actionsRow(html);
    expect(row.match(/<a /g)).toHaveLength(2);
    expect(row).toMatch(new RegExp(`<a href="/join/checkout" class="[^"]*">${label}</a>`));
    expect(row).toMatch(/<a href="\/join" class="[^"]*">Start again<\/a>/);
    expect(row.indexOf('href="/join/checkout"')).toBeLessThan(row.indexOf('href="/join"'));
  });

  it.each(['failed', 'missing', 'continue'] as const)('leaves the %s page without an actions row', async state => {
    expect(await render(state)).not.toContain('data-join-actions');
  });

  it('keeps the demo test-card hint before the cancelled actions row', async () => {
    const html = await render('cancelled', '4242 4242 4242 4242');
    actionsRow(html);
    expect(html).toContain('4242 4242 4242 4242');
    expect(html.indexOf('data-demo-test-card')).toBeLessThan(html.indexOf('data-join-actions'));
  });
});

describe('join form phone country choice', () => {
  const plan = { id: '019a08bf-1234-7000-8000-000000000003', name: 'Monthly', amountCents: 9000, currency: 'CAD', interval: 'monthly', plusTax: false,
    signupFeeCents: 0, trialDays: 0, commitmentMonths: null, revision: 1 } as const;
  const form = (address: Record<string, string> | undefined, values?: Record<string, string>) => String(joinFormPage({ gym: { ...gym, ...(address ? { address } : {}) }, t, plan,
    count: 1, templates: [], ...(values ? { values } : {}) }));
  const optionOf = (html: string, value: string) => new RegExp(`<option value="${value}"[^>]*>`).exec(html)?.[0] ?? '';
  /** The selected options of the phone country select only (the form's member count select has its own). */
  const selectedCountries = (html: string) => (/<select[^>]*name="phoneCountry"[\s\S]*?<\/select>/.exec(html)?.[0] ?? '').match(/<option [^>]*selected/g);

  it('selects the gym\'s country, with its calling code, and limits the number to 95 characters', () => {
    const html = form({ country: 'CA' });
    expect(html.match(/<select[^>]*name="phoneCountry"/g)).toHaveLength(1);
    expect(optionOf(html, 'CA')).toContain('data-calling-code="1"');
    expect(optionOf(html, 'CA')).toContain('selected');
    expect(optionOf(html, '')).not.toContain('selected');
    expect(selectedCountries(html)).toHaveLength(1);
    expect(/<input[^>]*name="phone"[^>]*>/.exec(html)?.[0]).toContain('maxlength="95"');
  });

  it('starts on "Choose a country" when the gym has no country', () => {
    const html = form(undefined);
    expect(optionOf(html, '')).toContain('selected');
    expect(selectedCountries(html)).toHaveLength(1);
  });

  it('keeps the visitor\'s choice and number when the form is shown again', () => {
    const html = form({ country: 'CA' }, { phoneCountry: 'GB', phone: '020 7946 0018' });
    expect(optionOf(html, 'GB')).toContain('selected');
    expect(optionOf(html, 'CA')).not.toContain('selected');
    expect(/<input[^>]*name="phone"[^>]*>/.exec(html)?.[0]).toContain('value="020 7946 0018"');
    expect(optionOf(form({ country: 'CA' }, { phoneCountry: '', phone: '604 555 0123' }), '')).toContain('selected');
  });

  it('adds under 18,000 characters of markup', () => {
    expect(String(phoneField(t, { label: 'Phone', country: 'CA' })).length).toBeLessThan(18_000);
  });
});
