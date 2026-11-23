// SPDX-License-Identifier: AGPL-3.0-only
import type { EmailTemplate } from '../../core/registry.js';
import { createElement } from 'react';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { localDate } from '@plaingym/shared/time';
import { EmailHeading, EmailText, renderEmail } from '../_shared/index.js';

export const templates: readonly EmailTemplate[] = [];

/** A staff cancellation of one booking. The member line appears when `showMembers` is set; the staff cancellation notice always sets it. */
export function renderBookingCancellation(input: {
  name: string; startsAt: Date; timezone: string; gymName: string; memberNames: string[]; showMembers: boolean; note: string;
}) {
  const t = createTranslator(locales.en ?? {});
  const values = { name: input.name, date: localDate(input.startsAt, input.timezone),
    time: new Intl.DateTimeFormat('en', { timeZone: input.timezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(input.startsAt) };
  return renderEmail({ gymName: input.gymName.trim() || t('bookings/bookings:gym'), language: 'en', t,
    subjectKey: 'bookings/bookings:cancelNoticeSubject', subjectValues: { name: input.name.replace(/[\r\n\0]/g, ' ') },
    footerKey: 'bookings/bookings:cancelNoticeFooter',
    children: createElement('div', { style: { overflowWrap: 'anywhere' } },
      createElement(EmailHeading, { t, messageKey: 'bookings/bookings:cancelNoticeSubject', values: { name: input.name } }),
      createElement(EmailText, { t, messageKey: 'bookings/bookings:cancelNoticeBody', values }),
      input.showMembers && input.memberNames.length
        ? createElement(EmailText, { t, messageKey: 'bookings/bookings:cancelNoticeMembers', values: { names: input.memberNames.join(', ') } }) : null,
      input.note.trim() ? createElement('p', { style: { whiteSpace: 'pre-wrap', fontSize: '16px', lineHeight: '24px' } }, input.note) : null),
  });
}

export function renderBookingPromotion(input: { name: string; startsAt: Date; timezone: string; gymName: string; memberNames?: string[] }) {
  const t = createTranslator(locales.en ?? {});
  const values = { name: input.name, date: new Intl.DateTimeFormat('en', { dateStyle: 'full', timeStyle: 'short', timeZone: input.timezone }).format(input.startsAt) };
  return renderEmail({ gymName: input.gymName.trim() || t('bookings/bookings:gym'), language: 'en', t,
    subjectKey: 'bookings/bookings:promotionSubject', subjectValues: values, footerKey: 'bookings/bookings:emailFooter',
    children: createElement('div', null,
      createElement(EmailHeading, { t, messageKey: 'bookings/bookings:promotionSubject', values }),
      createElement(EmailText, { t, messageKey: 'bookings/bookings:promotionBody', values }),
      input.memberNames?.length ? createElement(EmailText, { t, messageKey: 'bookings/bookings:promotionMembers', values: { names: input.memberNames.join(', ') } }) : null),
  });
}
