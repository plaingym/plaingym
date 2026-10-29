// SPDX-License-Identifier: AGPL-3.0-only
import type { EmailTemplate } from '../../core/registry.js';
import { createElement } from 'react';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { EmailHeading, EmailText, renderEmail } from '../_shared/index.js';

export const templates: readonly EmailTemplate[] = [];

export function renderBookingPromotion(input: { name: string; startsAt: Date; timezone: string }) {
  const t = createTranslator(locales.en ?? {});
  const values = { name: input.name, date: new Intl.DateTimeFormat('en', { dateStyle: 'full', timeStyle: 'short', timeZone: input.timezone }).format(input.startsAt) };
  return renderEmail({ gymName: t('bookings/bookings:gym'), language: 'en', t,
    subjectKey: 'bookings/bookings:promotionSubject', subjectValues: values, footerKey: 'bookings/bookings:emailFooter',
    children: createElement('div', null,
      createElement(EmailHeading, { t, messageKey: 'bookings/bookings:promotionSubject', values }),
      createElement(EmailText, { t, messageKey: 'bookings/bookings:promotionBody', values })),
  });
}
