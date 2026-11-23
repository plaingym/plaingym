// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { callingCodeOf, normalizePhone, normalizePhoneWithCallingCode } from './phone.js';
it.each([
  ['(202) 555-0123', 'US', '+12025550123'], ['020 7946 0018', 'GB', '+442079460018'],
  ['+44 20 7946 0018', null, '+442079460018'], ['2025550123', null, null],
  ['call +1 202 555 0123', 'US', null], ['+12025550123 ext 123', 'US', null],
  ['123', 'US', null], ['', 'US', null], ['+12025550123', 'ZZ', '+12025550123'],
])('normalizes %s in %s without guessing consent for an extension or prose', (phone, country, expected) => {
  expect(normalizePhone(phone, country)).toBe(expected);
});
it.each([
  ['+16045550123', '1'], ['+44 20 7946 0018', '44'], ['6045550123', null],
  ['+12025550123 ext 1', null], ['', null], [null, null], ['+1' + '2'.repeat(99), null],
] as const)('reads the calling code only from a valid international number: %s', (phone, expected) => {
  expect(callingCodeOf(phone)).toBe(expected);
});
it.each([
  ['(202) 555-0123', '1', '+12025550123'], ['020 7946 0018', '44', '+442079460018'],
  ['+44 20 7946 0018', '1', '+442079460018'], ['202 555 0123 ext 1', '1', null],
  ['123', '1', null], ['', '1', null],
] as const)('normalizes a national number with a calling code: %s / %s', (phone, callingCode, expected) => {
  expect(normalizePhoneWithCallingCode(phone, callingCode)).toBe(expected);
});
