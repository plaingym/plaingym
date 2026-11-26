// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { announcementSmsBody, announcementSmsText, smsSegments } from './sms-segments.js';

it.each([
  ['', 'GSM-7', 0, 0], ['a'.repeat(160), 'GSM-7', 160, 1], ['a'.repeat(161), 'GSM-7', 161, 2],
  ['^'.repeat(80), 'GSM-7', 160, 1], ['€'.repeat(81), 'GSM-7', 162, 2],
  ['界'.repeat(70), 'UCS-2', 70, 1], ['界'.repeat(71), 'UCS-2', 71, 2],
  ['😀'.repeat(35), 'UCS-2', 70, 1], ['😀'.repeat(36), 'UCS-2', 72, 2],
  ['^'.repeat(153), 'GSM-7', 306, 3], ['😀'.repeat(67), 'UCS-2', 134, 3],
] as const)('counts transport units and segments for %j', (body, encoding, units, segments) => {
  expect(smsSegments(body)).toEqual({ encoding, units, segments });
});
it('includes the gym name and mandatory STOP line in the shared composer text', () => {
  const body = announcementSmsBody('Cedar Gym', '  Hello  ');
  expect(body).toBe('Cedar Gym: Hello\nReply STOP to opt out');
  expect(smsSegments(body)).toEqual({ encoding: 'GSM-7', units: body.length, segments: 1 });
  expect(announcementSmsBody('Cedar Gym', ' Hi ')).toBe('Cedar Gym: ' + announcementSmsText(' Hi '));
});
