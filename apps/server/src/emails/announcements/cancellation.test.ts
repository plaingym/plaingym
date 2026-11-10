// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { renderCancellationNotice } from './cancellation.js';

it('renders gym-local time, every member name, a portal link and an escaped plain text note without unsubscribe', async () => {
  const mail = await renderCancellationNotice({ gymName: 'Cedar Gym', name: 'Practice <partners>',
    startsAt: new Date('2026-11-11T00:30:00Z'), timezone: 'America/New_York', memberNames: ['Mia <First>', 'Noa Second'],
    note: '<script>alert(1)</script>\nClosed today.', scheduleUrl: 'https://gym.example.test/portal/schedule' });
  expect(mail.subject).toBe('Cancelled: Practice <partners>');
  for (const value of ['Cedar Gym', '2026-11-10', '7:30 PM EST', 'Mia', 'Noa Second', '<script>alert(1)</script>', 'https://gym.example.test/portal/schedule'])
    expect(mail.text).toContain(value);
  expect(mail.html).toContain('&lt;script&gt;'); expect(mail.html).not.toContain('<script>');
  expect(mail.html).toContain('&lt;partners&gt;');
  expect(mail.text.toLowerCase()).not.toContain('unsubscribe');
  expect(mail.html.toLowerCase()).not.toContain('unsubscribe');
});
