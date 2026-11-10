// SPDX-License-Identifier: AGPL-3.0-only
import { createElement } from 'react';
import type { Translator } from '@plaingym/shared';
import { signedLinkPurposeSchema } from '@plaingym/shared/contracts';
import type { SignedLinkPurposeName } from '@plaingym/shared/contracts';
import type { EmailTemplate } from '../../core/registry.js';
import { EmailButton, EmailHeading, EmailText, renderEmail } from '../_shared/index.js';

export function renderSignedLink(input: {
  gymName: string; url: string; purpose: SignedLinkPurposeName; manualPayment?: boolean; noticeKey?: string;
}, t: Translator) {
  const purpose = signedLinkPurposeSchema.exclude(['unsubscribe']).parse(input.purpose);
  return renderEmail({
    gymName: input.gymName, t, subjectKey: `links/service:${purpose}.subject`, footerKey: 'links/service:footer',
    children: createElement('div', null,
      createElement(EmailHeading, { t, messageKey: `links/service:${purpose}.subject` }),
      input.manualPayment
        ? createElement(EmailText, { t, messageKey: 'links/service:manualPayment' })
        : createElement('div', null, createElement(EmailText, { t, messageKey: 'links/service:description' }),
          createElement(EmailButton, { t, messageKey: `links/service:${purpose}.button`, href: input.url }),
          input.noticeKey ? createElement(EmailText, { t, messageKey: input.noticeKey }) : null)),
  });
}
export const templates: readonly EmailTemplate[] = [{
  id: 'links.service.signed-link',
  async render(data, t) {
    if (typeof data !== 'object' || data === null
        || !('gymName' in data) || typeof data.gymName !== 'string'
        || !('url' in data) || typeof data.url !== 'string' || !('purpose' in data)
        || ('manualPayment' in data && typeof data.manualPayment !== 'boolean')
        || ('noticeKey' in data && typeof data.noticeKey !== 'string'))
      throw new Error('Expected signed link email data');
    return renderSignedLink({ gymName: data.gymName, url: data.url, purpose: signedLinkPurposeSchema.exclude(['unsubscribe']).parse(data.purpose),
      ...('manualPayment' in data ? { manualPayment: data.manualPayment as boolean } : {}),
      ...('noticeKey' in data ? { noticeKey: data.noticeKey as string } : {}) }, t);
  },
}];
