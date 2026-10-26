// SPDX-License-Identifier: AGPL-3.0-only
import type { EmailTemplate } from '../../core/registry.js';
import { createElement } from 'react';
import { createTranslator, type Translator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { zonedInstant } from '@plaingym/shared/time';
import { EmailButton, EmailHeading, EmailText, renderEmail } from '../_shared/index.js';

export const templates: readonly EmailTemplate[] = [];

const fallback = createTranslator(locales.en ?? {});
type AlertContent = { kind: 'cardExpiry'; dueOn: string; expiryMonth: number; expiryYear: number }
  | { kind: 'dispute'; number: number | string; disputeId: string; status: string };
export function renderBillingAlert(input: AlertContent & {
  url: string; timezone: string; gymName?: string; locale?: string;
}, translator?: Translator) {
  const t: Translator = (key, replacements) => {
    const translated = translator?.(key, replacements);
    return translated && translated !== key ? translated : fallback(key, replacements);
  };
  const language = input.locale ?? 'en';
  const values = input.kind === 'cardExpiry' ? {
    dueOn: new Intl.DateTimeFormat(language, { dateStyle: 'long', timeZone: input.timezone })
      .format(zonedInstant(input.dueOn, '12:00', input.timezone, { gap: 'shift' })!),
    expiry: new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric', timeZone: input.timezone })
      .format(zonedInstant(`${input.expiryYear}-${String(input.expiryMonth).padStart(2, '0')}-01`,
        '12:00', input.timezone, { gap: 'shift' })!),
  } : { number: input.number, disputeId: input.disputeId, status: input.status };
  const subjectKey = `billing/alerts:${input.kind}Subject`;
  return renderEmail({ gymName: input.gymName?.trim() || t('billing/alerts:gymNameFallback'), language, t,
    subjectKey, subjectValues: values, footerKey: 'billing/alerts:footer',
    children: createElement('div', null,
      createElement(EmailHeading, { t, messageKey: subjectKey, values }),
      createElement(EmailText, { t, messageKey: `billing/alerts:${input.kind}Body`, values }),
      createElement(EmailButton, { t, messageKey: `billing/alerts:${input.kind}Button`, href: input.url })),
  });
}
