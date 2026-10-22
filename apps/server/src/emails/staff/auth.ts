// SPDX-License-Identifier: AGPL-3.0-only
import type { EmailTemplate, RenderedEmail } from '../../core/registry.js';
import type { Translator } from '@plaingym/shared';
function escape(value: string) { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
export function renderAuthLink(url: string, t: Translator): RenderedEmail {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Invalid login URL');
  const subject = t('staff/auth:subject'), description = t('staff/auth:description'), button = t('staff/auth:button');
  return { subject, html: `<p>${escape(description)}</p><p><a href="${escape(url)}">${escape(button)}</a></p>`, text: `${description}\n\n${button}: ${url}` };
}
export const templates: readonly EmailTemplate[] = [{ id: 'staff.auth.magic-link', async render(data, t) {
  if (typeof data !== 'object' || data === null || !('url' in data) || typeof data.url !== 'string') throw new Error('Expected login URL');
  return renderAuthLink(data.url, t);
} }];
