// SPDX-License-Identifier: AGPL-3.0-only
import type { EmailTemplate, RenderedEmail } from '../../core/registry.js';
import type { Translator } from '@plaingym/shared';

function escape(value: string) { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
export function renderStaffInvitation(url: string, t: Translator): RenderedEmail {
  if (!['https:', 'http:'].includes(new URL(url).protocol)) throw new Error('Invalid invitation URL');
  const subject = t('staff/profiles:inviteSubject'), description = t('staff/profiles:inviteDescription'), button = t('staff/profiles:acceptInvitation');
  return { subject, html: `<p>${escape(description)}</p><p><a href="${escape(url)}">${escape(button)}</a></p>`, text: `${description}\n\n${button}: ${url}` };
}
export const templates: readonly EmailTemplate[] = [{ id: 'staff.profiles.invitation', async render(data, t) {
  if (!data || typeof data !== 'object' || !('url' in data) || typeof data.url !== 'string') throw new Error('Expected invitation URL');
  return renderStaffInvitation(data.url, t);
} }];
