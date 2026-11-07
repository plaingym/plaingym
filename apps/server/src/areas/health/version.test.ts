// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { runningVersion } from './version.js';

vi.mock('../../../../../scripts/release/version.mjs', () => ({
  buildInfo: () => ({ version: '0.4.0+unknown', commit: 'unknown' }),
}));

describe('runningVersion', () => {
  it.each([{}, { APP_VERSION: '', APP_REVISION: '' }])(
    'uses embedded archive identity for unset or empty overrides: %j', (env) => {
      expect(runningVersion(env)).toEqual({ version: '0.4.0+unknown', commit: 'unknown' });
    },
  );

  it('preserves explicit runtime identity overrides', () => {
    const commit = 'a'.repeat(40);
    expect(runningVersion({ APP_VERSION: '1.2.3', APP_REVISION: commit }))
      .toEqual({ version: '1.2.3', commit });
  });

  it('falls back independently for each empty override', () => {
    expect(runningVersion({ APP_VERSION: '1.2.3', APP_REVISION: '' }))
      .toEqual({ version: '1.2.3', commit: 'unknown' });
    expect(runningVersion({ APP_VERSION: '', APP_REVISION: 'a'.repeat(40) }))
      .toEqual({ version: '0.4.0+unknown', commit: 'a'.repeat(40) });
  });
});
