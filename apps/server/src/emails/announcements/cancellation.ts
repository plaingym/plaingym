// SPDX-License-Identifier: AGPL-3.0-only
import { createElement } from 'react';
import { createTranslator } from '@plaingym/shared';
import { localDate } from '@plaingym/shared/time';
import messages from '../../../../../locales/en/announcements/cancellation.json' with { type: 'json' };
import { EmailButton, EmailHeading, EmailText, renderEmail } from '../_shared/index.js';

const t = createTranslator({ 'announcements/cancellation': messages });
export function renderCancellationNotice(input: {
  gymName: string; name: string; startsAt: Date; timezone: string; memberNames: string[]; note: string; scheduleUrl: string;
}) {
  const values = { name: input.name, date: localDate(input.startsAt, input.timezone),
    time: new Intl.DateTimeFormat('en', { timeZone: input.timezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(input.startsAt) };
  return renderEmail({ gymName: input.gymName, t, footerKey: 'announcements/cancellation:footer',
    subjectKey: 'announcements/cancellation:subject', subjectValues: { name: input.name.replace(/[\r\n\0]/g, ' ') },
    children: createElement('div', { style: { overflowWrap: 'anywhere' } },
      createElement(EmailHeading, { t, messageKey: 'announcements/cancellation:subject', values: { name: input.name } }),
      createElement(EmailText, { t, messageKey: 'announcements/cancellation:when', values }),
      createElement(EmailText, { t, messageKey: 'announcements/cancellation:members', values: { names: input.memberNames.join(', ') } }),
      input.note.trim() ? createElement('p', { style: { whiteSpace: 'pre-wrap', fontSize: '16px', lineHeight: '24px' } }, input.note) : null,
      createElement(EmailButton, { t, messageKey: 'announcements/cancellation:schedule', href: input.scheduleUrl })),
  });
}
