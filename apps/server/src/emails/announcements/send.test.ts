// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import messages from '../../../../../locales/en/announcements/send.json' with { type: 'json' };
import { renderAnnouncement } from './send.js';
const t = createTranslator({ 'announcements/send': messages });
it('escapes markup and only links HTTP(S), with paragraphs and the recipient unsubscribe link', () => {
  const result = renderAnnouncement({ subject: 'Notice', gymName: '<Gym>', t, unsubscribe: 'https://gym.example/l/own-token',
    body: '<img src=x onerror=alert(1)>\n\nhttps://example.test/?a=1&b=2\nhttp://example.test/\njavascript:alert(1)\ndata:text/html,test' });
  expect(result.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(result.html).toContain('href="https://example.test/?a=1&amp;b=2"');
  expect(result.html).toContain('href="http://example.test/"');
  expect(result.html).not.toMatch(/href="(?:javascript|data):/);
  expect(result.html).toContain('href="https://gym.example/l/own-token"');
  expect(result.text).toContain('https://gym.example/l/own-token');
  expect(result.html).toContain('&lt;Gym&gt;');
});
it('leaves trailing sentence punctuation and unbalanced parentheses out of links', () => {
  const result = renderAnnouncement({ subject: 'Notice', gymName: 'Gym', t, unsubscribe: 'https://gym.example/l/own-token',
    body: 'Book here: https://gym.test/classes. (See https://gym.test/schedule) or https://gym.test/wiki/Judo_(sport)!' });
  expect(result.html).toContain('<a href="https://gym.test/classes">https://gym.test/classes</a>. (See');
  expect(result.html).toContain('<a href="https://gym.test/schedule">https://gym.test/schedule</a>) or');
  expect(result.html).toContain('<a href="https://gym.test/wiki/Judo_(sport)">https://gym.test/wiki/Judo_(sport)</a>!');
});
it('marks a test and renders an inert unsubscribe line', () => {
  const result = renderAnnouncement({ subject: 'Notice', body: 'Text', gymName: 'Gym', t });
  expect(result.subject).toBe('[Test] Notice');
  expect(result.html).toContain('inactive in this test');
  expect(result.html).not.toContain('/l/');
  expect(result.text).toContain('No members received it');
});
