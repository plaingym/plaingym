// SPDX-License-Identifier: AGPL-3.0-only
import { createElement } from 'react';
import { createTranslator } from '@plaingym/shared';
import { localDate } from '@plaingym/shared/time';
import messages from '../../../../../locales/en/announcements/restored.json' with { type: 'json' };
import { EmailButton, EmailHeading, EmailText, renderEmail } from '../_shared/index.js';

const t = createTranslator({ 'announcements/restored': messages });
/** A cancelled class is back on, and the places its cancellation cancelled are restored. */
export function renderRestoreNotice(input: {
  gymName: string; name: string; startsAt: Date; timezone: string; memberNames: string[];
  /** False when the notice covers only the person at that address. */
  showMembers: boolean; scheduleUrl: string;
}) {
  const values = { name: input.name, date: localDate(input.startsAt, input.timezone),
    time: new Intl.DateTimeFormat('en', { timeZone: input.timezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(input.startsAt) };
  return renderEmail({ gymName: input.gymName, t, footerKey: 'announcements/restored:footer',
    subjectKey: 'announcements/restored:subject', subjectValues: { name: input.name.replace(/[\r\n\0]/g, ' ') },
    children: createElement('div', { style: { overflowWrap: 'anywhere' } },
      createElement(EmailHeading, { t, messageKey: 'announcements/restored:subject', values: { name: input.name } }),
      createElement(EmailText, { t, messageKey: 'announcements/restored:when', values }),
      createElement(EmailText, { t, messageKey: 'announcements/restored:places' }),
      input.showMembers
        ? createElement(EmailText, { t, messageKey: 'announcements/restored:members', values: { names: input.memberNames.join(', ') } })
        : null,
      createElement(EmailButton, { t, messageKey: 'announcements/restored:schedule', href: input.scheduleUrl })),
  });
}
