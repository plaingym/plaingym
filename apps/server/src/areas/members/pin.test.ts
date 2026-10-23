// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { hashHouseholdPin, verifyHouseholdPin } from './pin.js';
it('binds a PIN to its secret, gym, household and domain, including leading zeros', () => {
  const secret = new Uint8Array(32).fill(7), hash = hashHouseholdPin(secret, 'gym-a', 'household-a', '0001');
  expect(verifyHouseholdPin(secret, 'gym-a', 'household-a', '0001', hash)).toBe(true);
  for (const [gymId, householdId, pin] of [['gym-b', 'household-a', '0001'], ['gym-a', 'household-b', '0001'], ['gym-a', 'household-a', '0002'], ['gym-a', 'household-a', 'bad']])
    expect(verifyHouseholdPin(secret, gymId!, householdId!, pin!, hash)).toBe(false);
  expect(verifyHouseholdPin(new Uint8Array(32).fill(8), 'gym-a', 'household-a', '0001', hash)).toBe(false);
  expect(verifyHouseholdPin(secret, 'gym-a', 'household-a', '0001', 'bad')).toBe(false);
  expect(() => hashHouseholdPin(new Uint8Array(1), 'a', 'b', '1234')).toThrow();
});
