// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { demoEntryResponse } from './index.js';

const expiresAt = '2099-10-24T12:00:00.000Z';
describe('demo discovery', () => {
  it.each([true, false])('carries whether a sandbox can take a join (%s)', (join) => {
    expect(demoEntryResponse.parse({ data: { mode: 'sandbox', expiresAt, join } }).data).toEqual({ mode: 'sandbox', expiresAt, join });
  });
  it('requires the flag on a sandbox and rejects it on the other modes', () => {
    expect(demoEntryResponse.safeParse({ data: { mode: 'sandbox', expiresAt } }).success).toBe(false);
    expect(demoEntryResponse.safeParse({ data: { mode: 'sandbox', expiresAt, join: 'yes' } }).success).toBe(false);
    for (const mode of ['entry', 'disabled']) expect(demoEntryResponse.safeParse({ data: { mode, join: true } }).success).toBe(false);
  });
});
