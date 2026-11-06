// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { test, expect, Client, gymOrigin, password } from '../support.js';

// The production sign-in limits, reached through the stack's proxy as visitors would: each `Client` has its own
// client address, so these attempts share no budget with the rest of the run (docs/security-model.md, Sign-in).
const attempt = (client: Client, email: string, secret = 'wrong-password-for-limit-tests') =>
  client.request('/api/auth/sign-in/email', 'POST', { email, password: secret });
const nobody = (label: string) => `limit-${label}-${randomBytes(6).toString('hex')}@example.invalid`;

test('one address may try 20 accounts a minute, then is refused with Retry-After while other addresses sign in', async ({ install }) => {
  expect(install.clients.front_desk.cookie).toContain('session_token=');
  const shared = new Client(gymOrigin);
  for (let i = 0; i < 20; i++) expect((await attempt(shared, nobody('address'))).status).toBe(401);
  const refused = await attempt(shared, nobody('address'));
  expect(refused.status, refused.text).toBe(429);
  expect(refused.retryAfter).toBeGreaterThan(0);
  expect(refused.retryAfter).toBeLessThanOrEqual(60);
  // The refusal is the address's: a staff account still signs in from another one.
  expect((await attempt(new Client(gymOrigin), 'front_desk@example.invalid', password)).status).toBe(200);
});

test('one account may be tried 10 times in ten minutes from any addresses, then is refused with Retry-After', async () => {
  const account = nobody('account');
  for (let i = 0; i < 10; i++) expect((await attempt(new Client(gymOrigin), account)).status).toBe(401);
  const refused = await attempt(new Client(gymOrigin), account);
  expect(refused.status, refused.text).toBe(429);
  expect(refused.retryAfter).toBeGreaterThan(540);
  expect(refused.retryAfter).toBeLessThanOrEqual(600);
  // The refusal is the account's: another account is still tried.
  expect((await attempt(new Client(gymOrigin), nobody('other'))).status).toBe(401);
});
