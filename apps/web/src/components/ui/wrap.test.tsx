// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { breaksAnywhere } from './wrap.test-helper.js';

// A file of its own: the helper compiles each document's classes once per module, and this case needs the
// wrap rules to be the first ones Tailwind emits (right after its license comment).
describe('breaksAnywhere', () => {
  it('reads the first generated rule like any other', () => {
    render(<p className="wrap-anywhere wrap-normal">{'one'}</p>);
    expect(breaksAnywhere(screen.getByText('one'))).toBe(false);
  });
});
