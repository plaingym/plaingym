// SPDX-License-Identifier: AGPL-3.0-only
import type { Translator } from '@plaingym/shared';
import { createElement as h, type ReactNode } from 'react';
import { renderEmail } from '../_shared/layout.js';

/** React escapes text; only explicit HTTP(S) URLs become links. */
function linkify(text: string, line: number): ReactNode[] {
  const result: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    let url = match[0];
    // Trailing sentence punctuation and an unbalanced closing parenthesis belong to the text, not the link.
    const count = (char: string) => url.split(char).length - 1;
    while (/[.,;:!?\]]$/.test(url) || (url.endsWith(')') && count(')') > count('('))) url = url.slice(0, -1);
    result.push(text.slice(offset, match.index));
    try {
      const parsed = new URL(url);
      result.push(parsed.username || parsed.password ? url : h('a', { key: `${line}-${match.index}`, href: parsed.href }, url));
    } catch { result.push(url); }
    offset = match.index + url.length;
  }
  result.push(text.slice(offset));
  return result;
}
export async function renderAnnouncement(input: { subject: string; body: string; gymName: string; t: Translator; unsubscribe?: string }) {
  const { t, unsubscribe } = input;
  const test = !unsubscribe;
  const subject = test ? t('announcements/send:testSubject', { subject: input.subject }) : input.subject;
  const paragraphs = input.body.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((paragraph, index) =>
    h('p', { key: index, style: { fontSize: '16px', lineHeight: '24px' } },
      paragraph.split('\n').flatMap((line, lineIndex) => [...(lineIndex ? [h('br', { key: `br-${lineIndex}` })] : []), ...linkify(line, lineIndex)])));
  return renderEmail({ gymName: input.gymName,
    t: (key, values) => key === 'announcements/send:subject' ? subject : t(key, values),
    subjectKey: 'announcements/send:subject',
    footerKey: unsubscribe ? 'announcements/send:unsubscribe' : 'announcements/send:testUnsubscribe',
    ...(unsubscribe ? { footerHref: unsubscribe } : {}),
    children: h('div', { style: { overflowWrap: 'anywhere', wordBreak: 'break-word' } },
      test ? h('p', null, t('announcements/send:testNotice')) : null, ...paragraphs),
  });
}
