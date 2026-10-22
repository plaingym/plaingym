// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { gymDomains, gyms } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { isInTransaction } from '@plaingym/shared/transaction';
import { createGymService, createGymsCommand, type OwnerInvitation } from './gyms.js';
import { decryptSecret, parseEncryptionKey } from '../core/secrets.js';
import { TestClock } from '../core/clock.js';
const database = useTestDatabase(), key = parseEncryptionKey('ab'.repeat(32)), clock = new TestClock('2026-10-22Z');
const input = { slug: 'test-gym', hostname: 'TEST.example.test:443', ownerEmail: 'OWNER@Example.test', name: 'Test Gym', timezone: 'America/Vancouver', currency: 'CAD' };
it('atomically persists the gym, primary domain and injected owner invitation', async () => {
  let invite: OwnerInvitation | undefined;
  const create = createGymService({ mode: 'multi', system: database.forSystem, key, clock, inviteOwner: async (_tx, invitation) => {
    expect(isInTransaction()).toBe(true); invite = invitation;
    return { invitationUrl: invitation.origin + '/invite/opaque-token' };
  } });
  const result = await create(input);
  expect(invite).toEqual({ gymId: result.gymId, email: 'owner@example.test', origin: 'https://test.example.test', expiresAt: new Date('2026-10-23Z') });
  const [gym] = await database.forGym(result.gymId, (tx) => tx.select().from(gyms));
  expect(gym).toMatchObject({ currency: 'CAD', timezone: 'America/Vancouver', billingEnabled: false, memberEmailsEnabled: false });
  expect(decryptSecret(key, 'qr_key', gym!.qrKey!)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const domains = await database.forGym(result.gymId, (tx) => tx.select().from(gymDomains));
  expect(domains).toMatchObject([{ hostname: 'test.example.test', kind: 'default' }]);
  expect(result).not.toHaveProperty('qrKey');
});
it('rolls back the gym and domain if invitation provisioning fails', async () => {
  const create = createGymService({ mode: 'multi', system: database.forSystem, key, clock, inviteOwner: async () => { throw new Error('failure'); } });
  await expect(create({ ...input, slug: 'failed', hostname: 'failed.example.test' })).rejects.toThrow('failure');
  expect(await database.forSystem((tx) => tx.select().from(gyms).where(eq(gyms.slug, 'failed')))).toEqual([]);
  expect(await database.forSystem((tx) => tx.select().from(gymDomains).where(eq(gymDomains.hostname, 'failed.example.test')))).toEqual([]);
});
it('rejects single mode and invalid details before provisioning', async () => {
  const inviteOwner = vi.fn(async () => ({ invitationUrl: 'https://example.test/invite' }));
  const single = createGymService({ mode: 'single', system: database.forSystem, key, clock, inviteOwner });
  await expect(single(input)).rejects.toMatchObject({ code: 'forbidden' });
  const multi = createGymService({ mode: 'multi', system: database.forSystem, key, clock, inviteOwner });
  await expect(multi({ ...input, hostname: 'bad/path' })).rejects.toMatchObject({ code: 'invalid_request' });
  expect(inviteOwner).not.toHaveBeenCalled();
});
it('validates CLI usage, prints the invitation once and redacts unexpected failures', async () => {
  const stdout = vi.fn(), stderr = vi.fn(), provision = vi.fn(async () => ({ gymId: 'gym', invitationUrl: 'https://example.test/invite/token' }));
  const command = createGymsCommand(provision);
  expect(await command.run([], { stdout, stderr })).toBe(2);
  const args = ['create', 'gym', 'gym.example.test', 'owner@example.test', 'Gym', 'UTC', 'USD'];
  expect(await command.run(args, { stdout, stderr })).toBe(0);
  expect(stdout).toHaveBeenCalledTimes(1); expect(provision).toHaveBeenCalledWith({ slug: 'gym', hostname: 'gym.example.test', ownerEmail: 'owner@example.test', name: 'Gym', timezone: 'UTC', currency: 'USD' });
  const failing = createGymsCommand(async () => { throw new Error('private credential'); });
  expect(await failing.run(args, { stdout, stderr })).toBe(1); expect(stderr).toHaveBeenLastCalledWith('Unable to create gym');
});
