// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import { renderPriceChangeNotice } from './price-change.js';
import { templates } from './memberships.js';

const input = { gymName: 'Cedar Gym', planName: 'All <classes>', timezone: 'America/Los_Angeles',
  effectiveOn: '2026-12-01', currency: 'USD', amountCents: 12500,
  memberships: [{ name: 'Mia <First>', amountCents: 10000, interval: 'monthly' as const, newInterval: 'monthly' as const }] };

it('renders one membership with gym, plan, prices, intervals and the local effective date in both parts', async () => {
  const mail = await renderPriceChangeNotice(input);
  expect(mail.subject).toBe('Membership price change');
  for (const value of ['Cedar Gym', 'Mia', '$100.00 per month', '$125.00 per month', 'first payment on or after December 1, 2026']) {
    expect(mail.text).toContain(value); expect(mail.html).toContain(value);
  }
  expect(mail.text).toContain('All <classes>');
  expect(mail.html).toContain('All &lt;classes&gt;');
  expect(mail.html).toContain('Mia &lt;First&gt;');
  expect(mail.html.toLowerCase()).not.toContain('unsubscribe');
  expect(mail.text.toLowerCase()).not.toContain('unsubscribe');
});
it('includes two members together and keeps each membership’s custom old price', async () => {
  const mail = await renderPriceChangeNotice({ ...input, memberships: [input.memberships[0]!,
    { name: 'Noa Second', amountCents: 8750, interval: 'monthly', newInterval: 'monthly' }] });
  for (const part of [mail.html, mail.text]) {
    expect(part).toContain('Noa Second'); expect(part).toContain('$87.50 per month'); expect(part).toContain('$100.00 per month');
  }
});
it('formats annual zero-decimal currency amounts through the shared money helper', async () => {
  const mail = await renderPriceChangeNotice({ ...input, currency: 'JPY', amountCents: 15000,
    memberships: [{ name: 'Annual Member', amountCents: 12000, interval: 'annual', newInterval: 'annual' }] });
  expect(mail.text).toContain('¥12,000 per year'); expect(mail.text).toContain('¥15,000 per year');
});
it('registers the template on the membership contribution and renders its validated input', async () => {
  const template = templates.find(entry => entry.id === 'billing.memberships.price_notice')!;
  expect(await template.render(input, createTranslator({}))).toEqual(await renderPriceChangeNotice(input));
  await expect(template.render({}, createTranslator({}))).rejects.toThrow();
});
