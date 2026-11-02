// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { advisoryLocks, gymAdvisoryLockKey, gymAdvisoryLocks } from './locks.js';

describe('advisory lock registry', () => {
  it('gives every (namespace, key) lock its own number', () => {
    const numbers = Object.values(advisoryLocks);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
  it('registers the charge failure lock under the key a running release already takes', () => {
    // Releases running side by side must hash the same text, so a gym in flight keeps one lock across an update.
    expect(gymAdvisoryLocks.chargeFailures).toBe('billing.runner.charge_failures');
    expect(gymAdvisoryLockKey('chargeFailures', '0198a000-0000-7000-8000-000000000001'))
      .toBe('billing.runner.charge_failures:0198a000-0000-7000-8000-000000000001');
  });
  it('takes a per-gym key: two gyms never share a lock, and no two locks share a name', () => {
    expect(gymAdvisoryLockKey('chargeFailures', 'gym-a')).not.toBe(gymAdvisoryLockKey('chargeFailures', 'gym-b'));
    const names = Object.values(gymAdvisoryLocks);
    expect(new Set(names).size).toBe(names.length);
  });
});
