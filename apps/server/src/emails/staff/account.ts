// SPDX-License-Identifier: AGPL-3.0-only
import type { RenderedEmail } from '../../core/registry.js';
import type { Translator } from '@plaingym/shared';
function escape(value: string) { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
/** Sent to the new address: the change applies only when this link is opened. */
export function renderEmailChangeLink(url: string, gymName: string, t: Translator): RenderedEmail {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Invalid confirmation URL');
  const subject = t('auth/account:changeSubject', { gym: gymName }), description = t('auth/account:changeDescription', { gym: gymName });
  const ignore = t('auth/account:changeIgnore'), button = t('auth/account:changeButton');
  return { subject, html: `<p>${escape(description)}</p><p><a href="${escape(url)}">${escape(button)}</a></p><p>${escape(ignore)}</p>`,
    text: `${description}\n\n${button}: ${url}\n\n${ignore}` };
}
/** Sent to the old address once the change has applied. Names the new address only masked. */
export function renderEmailChangedNotice(maskedNewEmail: string, gymName: string, t: Translator): RenderedEmail {
  const subject = t('auth/account:noticeSubject', { gym: gymName });
  const description = t('auth/account:noticeDescription', { gym: gymName, email: maskedNewEmail }), help = t('auth/account:noticeHelp', { gym: gymName });
  return { subject, html: `<p>${escape(description)}</p><p>${escape(help)}</p>`, text: `${description}\n\n${help}` };
}
