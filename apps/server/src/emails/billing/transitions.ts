// SPDX-License-Identifier: AGPL-3.0-only
import { createElement } from 'react';
import type { Translator } from '@plaingym/shared';
import type { EmailTemplate } from '../../core/registry.js';
import { EmailHeading, EmailText, renderEmail } from '../_shared/index.js';

/** A payment receipt in the shared layout, headed with the gym's name. */
export function renderReceipt(input: { gymName: string; number: string | number; amount: string }, t: Translator) {
  return renderEmail({
    gymName: input.gymName, t, subjectKey: 'billing/transitions:receiptSubject', subjectValues: { number: input.number },
    footerKey: 'billing/transitions:receiptFooter',
    children: createElement('div', null,
      createElement(EmailHeading, { t, messageKey: 'billing/transitions:receiptSubject', values: { number: input.number } }),
      createElement(EmailText, { t, messageKey: 'billing/transitions:receiptBody', values: { number: input.number, amount: input.amount } })),
  });
}

export const templates: readonly EmailTemplate[] = [];
