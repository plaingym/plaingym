// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { normalizePhone } from './phone.js';
it.each([
  ['(202) 555-0123', 'US', '+12025550123'], ['020 7946 0018', 'GB', '+442079460018'],
  ['+44 20 7946 0018', null, '+442079460018'], ['2025550123', null, null],
  ['call +1 202 555 0123', 'US', null], ['+12025550123 ext 123', 'US', null],
  ['123', 'US', null], ['', 'US', null], ['+12025550123', 'ZZ', '+12025550123'],
])('normalizes %s in %s without guessing consent for an extension or prose', (phone, country, expected) => {
  expect(normalizePhone(phone, country)).toBe(expected);
});
