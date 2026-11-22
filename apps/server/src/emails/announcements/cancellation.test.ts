// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { renderCancellationNotice } from './cancellation.js';

it('renders gym-local time, every member name, a portal link and an escaped plain text note without unsubscribe', async () => {
  const mail = await renderCancellationNotice({ gymName: 'Cedar Gym', name: 'Practice <partners>',
    startsAt: new Date('2026-11-11T00:30:00Z'), timezone: 'America/New_York', memberNames: ['Mia <First>', 'Noa Second'], showMembers: true,
    note: '<script>alert(1)</script>\nClosed today.', scheduleUrl: 'https://gym.example.test/portal/schedule' });
  expect(mail.subject).toBe('Cancelled: Practice <partners>');
  for (const value of ['Cedar Gym', '2026-11-10', '7:30 PM EST', 'Booked or waitlisted members: Mia', 'Noa Second', '<script>alert(1)</script>', 'https://gym.example.test/portal/schedule'])
    expect(mail.text).toContain(value);
  expect(mail.html).toContain('&lt;script&gt;'); expect(mail.html).not.toContain('<script>');
  expect(mail.html).toContain('&lt;partners&gt;');
  expect(mail.text.toLowerCase()).not.toContain('unsubscribe');
  expect(mail.html.toLowerCase()).not.toContain('unsubscribe');
});

it('leaves the members line out when it would name only the recipient', async () => {
  const mail = await renderCancellationNotice({ gymName: 'Cedar Gym', name: 'Practice', startsAt: new Date('2026-11-11T00:30:00Z'),
    timezone: 'America/New_York', memberNames: ['Mia First'], showMembers: false, note: '', scheduleUrl: 'https://gym.example.test/portal/schedule' });
  expect(mail.text).toContain('Practice on 2026-11-10 at 7:30 PM EST has been cancelled.');
  for (const body of [mail.text, mail.html]) { expect(body).not.toContain('Booked or waitlisted members'); expect(body).not.toContain('Mia First'); }
});
