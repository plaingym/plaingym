// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { localDate } from '@plaingym/shared/time';
import { needsCardExpiryAlert } from './index.js';
import { renderBillingAlert } from '../../../emails/billing/alerts.js';

describe('card-expiry calendar dates', () => {
  it.each([
    [2026, 11, '2026-12-01', '2026-10-31', false],
    [2026, 11, '2026-12-01', '2026-11-01', true],
    [2026, 11, '2026-12-01', '2026-11-30', true],
    [2026, 11, '2026-12-01', '2026-12-01', true],
    [2026, 11, '2026-12-01', '2026-12-02', false],
    [2026, 11, '2026-11-30', '2026-11-01', false],
    [2026, 12, '2027-01-01', '2026-12-02', true],
    [2028, 2, '2028-03-01', '2028-01-31', true],
    [2028, 2, '2028-02-29', '2028-01-31', false],
    [null, null, '2026-12-01', '2026-11-01', false],
  ])('expiry %s/%s, due %s, today %s => %s', (expiryYear, expiryMonth, cycle, today, expected) => {
    expect(needsCardExpiryAlert({ expiryMonth, expiryYear }, cycle, today)).toBe(expected);
  });
  it('opens the window on the gym date, independent of the host timezone', () => {
    const instant = new Date('2026-11-01T00:30:00Z'), card = { expiryMonth: 11, expiryYear: 2026 };
    expect(needsCardExpiryAlert(card, '2026-12-01', localDate(instant, 'America/Vancouver'))).toBe(false);
    expect(needsCardExpiryAlert(card, '2026-12-01', localDate(instant, 'Asia/Tokyo'))).toBe(true);
  });
  it('translates both alternatives and escapes untrusted replacement text', async () => {
    const message = await renderBillingAlert({ kind: 'cardExpiry', expiryMonth: 11, expiryYear: 2026, dueOn: '2026-12-01',
      timezone: 'America/Vancouver', gymName: 'Gym <tag>', url: 'https://gym.test/l/token?a=1&b=<tag>' });
    expect(message.text).toContain('November 2026');
    expect(message.text).not.toContain('{');
    expect(message.html).toContain('Gym &lt;tag&gt;');
    expect(message.html).toContain('&amp;b=%3Ctag%3E');
    expect((await renderBillingAlert({ kind: 'dispute', number: 3, disputeId: 'dp_test', status: 'open',
      timezone: 'UTC', url: 'https://gym.test/admin' }, key => key)).subject).toBe('Payment dispute for invoice 3');
  });
  it('brands the layout and formats the gym-local dates in text and HTML', async () => {
    const message = await renderBillingAlert({ kind: 'cardExpiry', expiryMonth: 11, expiryYear: 2026,
      dueOn: '2026-12-01', timezone: 'Pacific/Honolulu', gymName: 'Riverside Gym', url: 'https://gym.test/l/token' });
    for (const alternative of [message.text, message.html]) {
      expect(alternative).toContain('Riverside Gym');
      expect(alternative).toContain('December 1, 2026');
      expect(alternative).toContain('November 2026');
      expect(alternative).not.toContain('2026-12-01');
    }
    expect(message.html).toContain('href="https://gym.test/l/token"');
    expect(message.text).toContain('Update your card');
  });
  it('uses the supplied display locale for calendar dates', async () => {
    const message = await renderBillingAlert({ kind: 'cardExpiry', expiryMonth: 11, expiryYear: 2026,
      dueOn: '2026-12-01', timezone: 'Asia/Tokyo', gymName: 'Riverside Gym', locale: 'en-GB', url: 'https://gym.test/l/token' });
    expect(message.text).toContain('1 December 2026');
  });
});
