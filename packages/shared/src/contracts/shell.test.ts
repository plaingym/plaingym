// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { shellSessionSchema } from './shell.js';

it('accepts an optional gym-scoped staff profile, including no profile, without accepting arbitrary IDs', () => {
  const session = { userId: '019a08bf-1234-7000-8000-000000000001', displayName: null, roles: ['coach'], member: false };
  expect(shellSessionSchema.parse(session)).toEqual(session);
  expect(shellSessionSchema.parse({ ...session, staffProfileId: null }).staffProfileId).toBeNull();
  expect(shellSessionSchema.parse({ ...session, staffProfileId: session.userId }).staffProfileId).toBe(session.userId);
  expect(shellSessionSchema.safeParse({ ...session, staffProfileId: 'other-profile' }).success).toBe(false);
});
