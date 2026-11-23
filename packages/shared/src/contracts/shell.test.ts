// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { shellBootstrapSchema, shellSessionSchema } from './shell.js';

it('accepts a bootstrap with or without the gym\'s two-letter country code, and refuses other shapes', () => {
  const gym = { id: '019a08bf-1234-7000-8000-000000000002', name: 'Gym', timezone: 'America/Vancouver', currency: 'CAD', enabledModules: [] };
  const bootstrap = { gym, session: null, login: { password: true, magicLink: false } };
  expect(shellBootstrapSchema.safeParse(bootstrap).success).toBe(true);
  expect(shellBootstrapSchema.parse({ ...bootstrap, gym: { ...gym, country: 'CA' } }).gym.country).toBe('CA');
  expect(shellBootstrapSchema.safeParse({ ...bootstrap, gym: { ...gym, country: 'ca' } }).success).toBe(false);
  expect(shellBootstrapSchema.safeParse({ ...bootstrap, gym: { ...gym, country: 'CAN' } }).success).toBe(false);
});

it('accepts an optional gym-scoped staff profile, including no profile, without accepting arbitrary IDs', () => {
  const session = { userId: '019a08bf-1234-7000-8000-000000000001', displayName: null, roles: ['coach'], member: false };
  expect(shellSessionSchema.parse(session)).toEqual(session);
  expect(shellSessionSchema.parse({ ...session, staffProfileId: null }).staffProfileId).toBeNull();
  expect(shellSessionSchema.parse({ ...session, staffProfileId: session.userId }).staffProfileId).toBe(session.userId);
  expect(shellSessionSchema.safeParse({ ...session, staffProfileId: 'other-profile' }).success).toBe(false);
});
