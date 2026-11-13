// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { escapeLike } from './escape-like.js';

it('escapes literal wildcard and escape characters while preserving Unicode names', () => {
  expect(escapeLike('50%_\\ Smith')).toBe('50\\%\\_\\\\ Smith');
  expect(escapeLike('Zoë 李')).toBe('Zoë 李');
});
