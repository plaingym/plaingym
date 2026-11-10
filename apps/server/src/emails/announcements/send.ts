// SPDX-License-Identifier: AGPL-3.0-only
import type { Translator } from '@plaingym/shared';

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** User text is escaped first; only explicit HTTP(S) URLs become links. */
function linkify(text: string) {
  let result = '', offset = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    let url = match[0];
    // Trailing sentence punctuation and an unbalanced closing parenthesis belong to the text, not the link.
    const count = (char: string) => url.split(char).length - 1;
    while (/[.,;:!?\]]$/.test(url) || (url.endsWith(')') && count(')') > count('('))) url = url.slice(0, -1);
    result += escape(text.slice(offset, match.index));
    try {
      const parsed = new URL(url);
      result += parsed.username || parsed.password ? escape(url) : `<a href="${escape(parsed.href)}">${escape(url)}</a>`;
    } catch { result += escape(url); }
    offset = match.index + url.length;
  }
  return result + escape(text.slice(offset));
}
export function renderAnnouncement(input: { subject: string; body: string; gymName: string; t: Translator; unsubscribe?: string }) {
  const { t, unsubscribe } = input;
  const test = !unsubscribe;
  const subject = test ? t('announcements/send:testSubject', { subject: input.subject }) : input.subject;
  const notice = test ? t('announcements/send:testNotice') : '';
  const footer = unsubscribe ? t('announcements/send:unsubscribe') : t('announcements/send:testUnsubscribe');
  const paragraphs = input.body.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(p => `<p>${linkify(p).replace(/\n/g, '<br>')}</p>`).join('');
  return { subject, text: [input.gymName, notice, input.body, footer, unsubscribe].filter(Boolean).join('\n\n'),
    html: `<!doctype html><html><body style="margin:0;padding:16px;font:16px/1.5 Arial,sans-serif;overflow-wrap:anywhere"><main style="max-width:600px;margin:auto"><p>${escape(input.gymName)}</p>${notice ? `<p>${escape(notice)}</p>` : ''}${paragraphs}<p>${unsubscribe ? `<a style="display:inline-block;padding:10px 0;min-height:24px" href="${escape(unsubscribe)}">${escape(footer)}</a>` : escape(footer)}</p></main></body></html>` };
}
