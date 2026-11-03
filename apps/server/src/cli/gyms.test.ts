// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { gymDomains, gyms, auditEvents } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { isInTransaction } from '@plaingym/shared/transaction';
import { createGymService, createGymsCommand } from './gyms.js';
import { decryptSecret, parseEncryptionKey } from '../core/secrets.js';
import { TestClock } from '../core/clock.js';
const database = useTestDatabase(), key = parseEncryptionKey('ab'.repeat(32)), clock = new TestClock('2026-10-22Z');
const input = { slug: 'test-gym', hostname: 'TEST.example.test:443', ownerEmail: 'OWNER@Example.test', name: 'Test Gym', timezone: 'America/Vancouver', currency: 'CAD' };
it('commits one audited gym and domain before owner provisioning, including concurrent retries', async () => {
  const provisionOwner = vi.fn(async () => {
    expect(isInTransaction()).toBe(false);
    return { userId: 'owner', delivery: 'email' as const };
  });
  const create = createGymService({ mode: 'multi', system: database.forSystem, key, clock, provisionOwner });
  const [result, retry] = await Promise.all([create(input), create(input)]);
  expect(retry).toEqual(result);
  expect(provisionOwner).toHaveBeenCalledWith({ gymId: result.gymId, email: 'owner@example.test', name: 'Test Gym', origin: 'https://test.example.test' });
  const [gym] = await database.forGym(result.gymId, (tx) => tx.select().from(gyms));
  expect(gym).toMatchObject({ currency: 'CAD', timezone: 'America/Vancouver', billingEnabled: false, memberEmailsEnabled: false });
  expect(decryptSecret(key, 'qr_key', gym!.qrKey!)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const domains = await database.forGym(result.gymId, (tx) => tx.select().from(gymDomains));
  expect(domains).toMatchObject([{ hostname: 'test.example.test', kind: 'default' }]);
  const audits = await database.forGym(result.gymId, (tx) => tx.select().from(auditEvents));
  expect(audits.filter((event) => event.action === 'gym.created')).toHaveLength(1);
  expect(result).not.toHaveProperty('qrKey');
});
it.each(['CET', 'PST', 'Mars/Olympus', 'Etc/GMT+5'])('refuses the timezone %s before reserving anything', async (timezone) => {
  const provisionOwner = vi.fn();
  const create = createGymService({ mode: 'multi', system: database.forSystem, key, clock, provisionOwner });
  await expect(create({ ...input, slug: 'bad-zone', hostname: 'bad-zone.example.test', timezone }))
    .rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('timezone') });
  expect(provisionOwner).not.toHaveBeenCalled();
  expect(await database.forSystem((tx) => tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.slug, 'bad-zone')))).toHaveLength(0);
});
it.each(['cad', 'CA', 'CAD1', ''])('refuses the currency "%s" with its own message before reserving anything', async (currency) => {
  const provisionOwner = vi.fn();
  const create = createGymService({ mode: 'multi', system: database.forSystem, key, clock, provisionOwner });
  const rejected = await create({ ...input, slug: 'bad-currency', hostname: 'bad-currency.example.test', currency }).catch((error: unknown) => error);
  expect(rejected).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('currency') });
  expect((rejected as Error).message).not.toContain('timezone');
  expect(provisionOwner).not.toHaveBeenCalled();
  expect(await database.forSystem((tx) => tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.slug, 'bad-currency')))).toHaveLength(0);
});
it('stores a timezone under its canonical name, so a retry with another spelling is the same gym', async () => {
  const provisionOwner = vi.fn(async () => ({ userId: 'owner', delivery: 'email' as const }));
  const create = createGymService({ mode: 'multi', system: database.forSystem, key, clock, provisionOwner });
  const first = { ...input, slug: 'canonical-zone', hostname: 'canonical-zone.example.test', timezone: 'america/vancouver' };
  const created = await create(first);
  expect((await database.forGym(created.gymId, (tx) => tx.select({ timezone: gyms.timezone }).from(gyms)))[0]!.timezone).toBe('America/Vancouver');
  expect(await create({ ...first, timezone: 'America/Vancouver' })).toEqual(created);
  // A quoted argument with a space around it is the same zone, as in the settings form.
  expect(await create({ ...first, timezone: ' America/Vancouver ' })).toEqual(created);
});
it('prints the timezone and currency messages and exits 1', async () => {
  const stdout = vi.fn(), stderr = vi.fn();
  const command = createGymsCommand(async (details) => createGymService({ mode: 'multi', system: database.forSystem, key, clock,
    provisionOwner: async () => ({ userId: 'owner', delivery: 'email' as const }) })({ ...details, hostname: 'cli-zone.example.test', slug: 'cli-zone' }));
  expect(await command.run(['create', 'cli-zone', 'cli-zone.example.test', 'owner@example.test', 'Gym', 'PST', 'USD'], { stdout, stderr })).toBe(1);
  expect(stderr).toHaveBeenLastCalledWith('Use UTC or a region such as America/Vancouver for the timezone');
  expect(await command.run(['create', 'cli-zone', 'cli-zone.example.test', 'owner@example.test', 'Gym', 'UTC', 'dollars'], { stdout, stderr })).toBe(1);
  expect(stderr).toHaveBeenLastCalledWith('Use a three-letter currency code such as CAD for the currency');
  expect(stdout).not.toHaveBeenCalled();
});
it('resumes a committed reservation after owner failure and rejects changed owner or hostname', async () => {
  const provisionOwner = vi.fn().mockRejectedValueOnce(new Error('failure')).mockResolvedValue({ userId: 'owner', delivery: 'email' });
  const create = createGymService({ mode: 'multi', system: database.forSystem, key, clock, provisionOwner });
  const failed = { ...input, slug: 'failed', hostname: 'failed.example.test' };
  await expect(create(failed)).rejects.toThrow('failure');
  const [reserved] = await database.forSystem((tx) => tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.slug, 'failed')));
  expect(reserved).toBeDefined();
  expect(await create(failed)).toMatchObject({ gymId: reserved!.id });
  await expect(create({ ...failed, ownerEmail: 'other@example.test' })).rejects.toMatchObject({ code: 'conflict' });
  await expect(create({ ...failed, hostname: 'other.example.test' })).rejects.toMatchObject({ code: 'conflict' });
  expect(provisionOwner).toHaveBeenCalledTimes(2);
});
it('rejects single mode and invalid details before provisioning', async () => {
  const provisionOwner = vi.fn(async () => ({ userId: 'owner', delivery: 'email' as const }));
  const single = createGymService({ mode: 'single', system: database.forSystem, key, clock, provisionOwner });
  await expect(single(input)).rejects.toMatchObject({ code: 'forbidden' });
  const multi = createGymService({ mode: 'multi', system: database.forSystem, key, clock, provisionOwner });
  await expect(multi({ ...input, hostname: 'bad/path' })).rejects.toMatchObject({ code: 'invalid_request' });
  expect(provisionOwner).not.toHaveBeenCalled();
});
it('validates CLI usage, reports delivery without a token and redacts unexpected failures', async () => {
  const stdout = vi.fn(), stderr = vi.fn(), provision = vi.fn(async () => ({ gymId: 'gym', userId: 'owner', delivery: 'email' as const }));
  const command = createGymsCommand(provision);
  expect(await command.run([], { stdout, stderr })).toBe(2);
  const args = ['create', 'gym', 'gym.example.test', 'owner@example.test', 'Gym', 'UTC', 'USD'];
  expect(await command.run(args, { stdout, stderr })).toBe(0);
  expect(stdout).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ gymId: 'gym', userId: 'owner', delivery: 'email' }));
  const failing = createGymsCommand(async () => { throw new Error('private credential'); });
  expect(await failing.run(args, { stdout, stderr })).toBe(1); expect(stderr).toHaveBeenLastCalledWith('Unable to create gym');
});
