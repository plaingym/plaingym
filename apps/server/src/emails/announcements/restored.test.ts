// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { renderRestoreNotice } from './restored.js';

it('renders gym-local time, every member name and a portal link without unsubscribe', async () => {
  const mail = await renderRestoreNotice({ gymName: 'Cedar Gym', name: 'Practice <partners>',
    startsAt: new Date('2026-11-11T00:30:00Z'), timezone: 'America/New_York', memberNames: ['Mia <First>', 'Noa Second'], showMembers: true,
    scheduleUrl: 'https://gym.example.test/portal/schedule' });
  expect(mail.subject).toBe('Back on: Practice <partners>');
  for (const value of ['Cedar Gym', 'Practice <partners> on 2026-11-10 at 7:30 PM EST is going ahead after all.',
    'The places cancelled with this class are back.', 'Places restored for: Mia <First>, Noa Second', 'https://gym.example.test/portal/schedule'])
    expect(mail.text).toContain(value);
  expect(mail.html).toContain('&lt;partners&gt;'); expect(mail.html).toContain('Mia &lt;First&gt;');
  expect(mail.html).not.toContain('<First>');
  expect(mail.text.toLowerCase()).not.toContain('unsubscribe');
  expect(mail.html.toLowerCase()).not.toContain('unsubscribe');
});

it('leaves the members line out when it would name only the recipient', async () => {
  const mail = await renderRestoreNotice({ gymName: 'Cedar Gym', name: 'Practice', startsAt: new Date('2026-11-11T00:30:00Z'),
    timezone: 'America/New_York', memberNames: ['Mia First'], showMembers: false, scheduleUrl: 'https://gym.example.test/portal/schedule' });
  expect(mail.text).toContain('Practice on 2026-11-10 at 7:30 PM EST is going ahead after all.');
  for (const body of [mail.text, mail.html]) { expect(body).not.toContain('Places restored for'); expect(body).not.toContain('Mia First'); }
});
