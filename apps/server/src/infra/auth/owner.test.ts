// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { authUser, authAccount, staffRoles, auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { isInTransaction } from '@plaingym/shared/transaction';
import { createOwnerService } from '../../areas/staff/auth.owner.js';
import { createGymService, createGymsCommand } from '../../cli/gyms.js';
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { captureSmtp } from '../email/test-smtp.js';
import { TestClock } from '../../core/clock.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { createAccountService } from './accounts.js';
import { createAuthService } from './service.js';
import { authConfig } from './config.js';
import { passwordAdapter } from './password.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-10-22Z');
const config = authConfig({ AUTH_SECRET: 'owner-bootstrap-test-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'on' }, false);
const accounts = createAccountService(config, () => database.system.db);

it('resumes gym creation after failed delivery, reuses one identity and owner, and sends a verifiable gym-bound link', async () => {
  const links: string[] = [];
  let failDelivery = true;
  const auth = createAuthService({ config, database: () => database.system.db, sendMagicLink: async ({ url }) => {
    expect(isInTransaction()).toBe(false);
    if (failDelivery) throw new Error('SMTP unavailable');
    links.push(url);
  } });
  const provisionOwner = createOwnerService({ accounts, clock, sendMagicLink: async (input) => {
    const roles = await database.forGym(input.gymId, (tx) => tx.select().from(staffRoles));
    expect(roles).toMatchObject([{ role: 'owner' }]);
    await auth.bind({ gymId: input.gymId, origin: input.origin, clientIp: '127.0.0.1' }).sendLoginLink(input.email);
  } });
  const create = createGymService({ mode: 'multi', system: database.forSystem, key: parseEncryptionKey('ab'.repeat(32)), clock, provisionOwner });
  const input = { name: 'Retry Gym', slug: 'retry-gym', hostname: 'retry.example.test', ownerEmail: 'OWNER@Example.test', timezone: 'UTC', currency: 'USD' };
  await expect(create(input)).rejects.toThrow();
  failDelivery = false;
  const result = await create(input);
  expect(await create(input)).toEqual(result);
  expect(result.delivery).toBe('email');
  const users = await database.system.db.select().from(authUser).where(eq(authUser.email, 'owner@example.test'));
  expect(users).toHaveLength(1);
  expect(await database.forGym(result.gymId, (tx) => tx.select().from(staffRoles))).toHaveLength(1);
  const audits = await database.forGym(result.gymId, (tx) => tx.select().from(auditEvents));
  for (const action of ['gym.created', 'auth.user_created', 'auth.owner_provisioned']) expect(audits.filter((event) => event.action === action)).toHaveLength(1);
  expect(links).toHaveLength(2); // Retries may resend; credentials and grants are never duplicated.
  const bound = auth.bind({ gymId: result.gymId, origin: 'https://retry.example.test', clientIp: '127.0.0.1' });
  const verified = await bound.handler(new Request(links[0]!));
  expect(verified.status).toBe(302);
  const cookie = verified.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  expect(await bound.getSession(new Request('https://retry.example.test/api/auth/get-session', { headers: { cookie } }))).toEqual({ userId: result.userId });
});

it('concurrently provisions one owner per gym without sharing another gym role', async () => {
  const gymId = uuidv7(), otherGym = uuidv7();
  await factory('gyms', gymId); await factory('gyms', otherGym);
  const provision = createOwnerService({ accounts, clock, sendMagicLink: async () => {} });
  const input = { gymId, email: 'concurrent@example.test', name: 'Owner', origin: 'https://concurrent.example.test' };
  const results = await Promise.all(Array.from({ length: 5 }, () => provision(input)));
  expect(new Set(results.map((result) => result.userId)).size).toBe(1);
  expect(await database.forGym(gymId, (tx) => tx.select().from(staffRoles))).toHaveLength(1);
  expect(await database.forGym(otherGym, (tx) => tx.select().from(staffRoles))).toEqual([]);
  const audits = await database.forGym(gymId, (tx) => tx.select().from(auditEvents));
  expect(audits.filter((event) => event.action === 'auth.owner_provisioned')).toHaveLength(1);
});

it('does not replace an existing staff role and rolls back new identities if the owner write fails', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const existing = await factory('authUser', gymId);
  await factory('staffRoles', gymId, { userId: existing.id, role: 'coach' });
  const provision = createOwnerService({ accounts, clock, sendMagicLink: async () => { throw new Error('must not send'); } });
  await expect(provision({ gymId, email: existing.email, name: 'Owner', origin: 'https://example.test' })).rejects.toMatchObject({ code: 'conflict' });
  const email = 'rollback-owner@example.test';
  await expect(provision({ gymId: uuidv7(), email, name: 'Owner', origin: 'https://example.test' })).rejects.toThrow();
  expect(await accounts.findUserByEmail(email)).toBeNull();
});

it('supports password setup retries without resetting credentials or duplicating the owner', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const provision = createOwnerService({ accounts, clock, sendMagicLink: async () => { throw new Error('must not send'); } });
  const input = { gymId, email: 'setup-owner@example.test', name: 'Owner', origin: 'https://example.test', password: 'setup-password-123' };
  const result = await provision(input);
  expect(await provision(input)).toEqual(result);
  await expect(provision({ ...input, password: 'replacement-password' })).rejects.toMatchObject({ code: 'conflict' });
  const [credential] = await database.system.db.select().from(authAccount).where(eq(authAccount.userId, result.userId));
  expect(await passwordAdapter.verify({ hash: credential!.password!, password: input.password })).toBe(true);
  expect(await database.forGym(gymId, (tx) => tx.select().from(staffRoles))).toHaveLength(1);
});

it('runs the default gyms-create command through account provisioning and SMTP without an invitation hook', async () => {
  const smtp = await captureSmtp();
  await initializeDatabase(database.appUrl);
  for (const [name, value] of Object.entries({ AUTH_SECRET: config.secret, AUTH_PASSWORD_LOGIN: 'off', TENANCY: 'multi',
    APP_ENCRYPTION_KEY: 'ab'.repeat(32), SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURITY: 'plain',
    SMTP_FROM: 'login@example.test', SMTP_USER: '', SMTP_PASS: '' })) vi.stubEnv(name, value);
  try {
    const stdout = vi.fn(), stderr = vi.fn();
    const command = createGymsCommand();
    const args = ['create', 'default-gym', 'default.example.test', 'default-owner@example.test', 'Default Gym', 'UTC', 'USD'];
    expect(await command.run(args, { stdout, stderr })).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    const result = JSON.parse(String(stdout.mock.calls[0]![0])) as { gymId: string; userId: string; delivery: string };
    expect(result.delivery).toBe('email');
    expect(await accounts.findUserByEmail('default-owner@example.test')).toEqual({ id: result.userId });
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]).toContain('https://default.example.test/api/auth/magic-link/verify');
    expect(String(stdout.mock.calls[0]![0])).not.toContain('token');
    expect(await command.run(args, { stdout, stderr })).toBe(0);
    expect(stdout.mock.calls[1]![0]).toBe(stdout.mock.calls[0]![0]);
    expect(smtp.messages).toHaveLength(2);
  } finally { vi.unstubAllEnvs(); await closeDatabase(); await smtp.close(); }
});
