// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { checkIntegrationsEnvironment } from './integrations.js';

describe('early integrations environment validation', () => {
  it('rejects an unknown multi-gym policy without opening a database', () => {
    expect(() => checkIntegrationsEnvironment('multi', { GYM_INTEGRATIONS: 'unknown' })).toThrow('Invalid GYM_INTEGRATIONS');
  });
  it('accepts both multi-gym policies and ignores the policy in single-gym mode', () => {
    for (const value of [undefined, '', 'operator', 'gym'])
      expect(() => checkIntegrationsEnvironment('multi', { GYM_INTEGRATIONS: value })).not.toThrow();
    expect(() => checkIntegrationsEnvironment('single', { GYM_INTEGRATIONS: 'unknown' })).not.toThrow();
  });
});
