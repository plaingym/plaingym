// SPDX-License-Identifier: AGPL-3.0-only
import { createElement } from 'react';
import { createTranslator } from '@plaingym/shared';
import { formatMinorUnits } from '@plaingym/shared/money';
import { zonedInstant } from '@plaingym/shared/time';
import { currencySchema, dateSchema } from '@plaingym/shared/contracts';
import { z } from 'zod';
import messages from '../../../../../locales/en/billing/price-notice.json' with { type: 'json' };
import { EmailHeading, EmailText, renderEmail } from '../_shared/index.js';

const interval = z.enum(['monthly', 'annual']);
export const priceChangeEmailSchema = z.object({
  gymName: z.string(), planName: z.string(), timezone: z.string(), effectiveOn: dateSchema,
  currency: currencySchema, amountCents: z.int32().nonnegative(),
  memberships: z.array(z.object({ name: z.string(), amountCents: z.int32().nonnegative(),
    interval, newInterval: interval })).min(1),
});
const t = createTranslator({ 'billing/price-notice': messages });
export function renderPriceChangeNotice(input: z.infer<typeof priceChangeEmailSchema>) {
  const date = new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: input.timezone })
    .format(zonedInstant(input.effectiveOn, '12:00', input.timezone, { gap: 'shift' })!);
  return renderEmail({ gymName: input.gymName, t, footerKey: 'billing/price-notice:footer',
    subjectKey: 'billing/price-notice:subject',
    children: createElement('div', { style: { overflowWrap: 'anywhere' } },
      createElement(EmailHeading, { t, messageKey: 'billing/price-notice:subject' }),
      createElement(EmailText, { t, messageKey: 'billing/price-notice:effective', values: { date } }),
      ...input.memberships.map((member, index) => createElement('div', { key: index },
        createElement(EmailText, { t, messageKey: 'billing/price-notice:membership', values: { name: member.name, plan: input.planName } }),
        createElement(EmailText, { t, messageKey: 'billing/price-notice:prices', values: {
          oldPrice: formatMinorUnits(member.amountCents, input.currency),
          newPrice: formatMinorUnits(input.amountCents, input.currency),
          oldInterval: t(`billing/price-notice:${member.interval}`), newInterval: t(`billing/price-notice:${member.newInterval}`),
        } }))),
    ),
  });
}
