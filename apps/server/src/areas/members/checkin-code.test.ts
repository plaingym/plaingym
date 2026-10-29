// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { deriveCheckinCode, hashCheckinCode } from './checkin-code.js';

it('separates codes by gym, member, version, key and purpose', () => {
  const key = new Uint8Array(32).fill(7), derive = (gym = 'gym', member = 'member', version = 1, secret = key) => deriveCheckinCode(secret, gym, member, version);
  const code = derive();
  expect(code).toBe(derive());
  expect(new Set([code, derive('other'), derive('gym', 'other'), derive('gym', 'member', 2), derive('gym', 'member', 1, new Uint8Array(32).fill(8))]).size).toBe(5);
  expect(hashCheckinCode(code)).toMatch(/^[a-f0-9]{64}$/);
  expect(hashCheckinCode(code)).not.toBe(code);
  expect(derive('GYM', 'MEMBER')).toBe(code); // UUID case does not change a member's credential.
});
it('fails closed on weak gym keys and invalid versions', () => {
  expect(() => deriveCheckinCode(new Uint8Array(31), 'gym', 'member', 1)).toThrow();
  for (const version of [0, -1, 1.5, NaN, Infinity]) expect(() => deriveCheckinCode(new Uint8Array(32), 'gym', 'member', version)).toThrow();
});
