// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { healthTileSchema } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { createAutoUpdateSettings } from '../settings/auto-update.js';
import messages from '../../../../../locales/en/health/auto-update.json' with { type: 'json' };
import { autoUpdateAttemptSchema, autoUpdateReasons, createAutoUpdateAttempts, createAutoUpdateHealthProvider, type AutoUpdateAttempt } from './auto-update.js';
import { createAutoUpdateCommand } from './auto-update.cli.js';
import { createHealthService } from './status.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7();
  await factory('gyms', gymId, { timezone: 'Australia/Sydney' });
  const clock = new TestClock('2026-11-03T16:30:00Z'), user = await factory('authUser', gymId);
  const settings = createAutoUpdateSettings({ scope: db.forGym, clock });
  const attempts = createAutoUpdateAttempts({ scope: db.forGym, clock });
  const provider = createAutoUpdateHealthProvider({ scope: db.forGym, settings, tenancy: 'single' });
  const tile = async () => healthTileSchema.parse(await provider.read({ gymId, roles: ['owner'], clock }));
  const turn = async (enabled: boolean) => settings.update({ gymId, actor: { kind: 'user', userId: user.id } },
    { enabled, revision: (await settings.get(gymId)).revision });
  const io = () => { const out: string[] = [], err: string[] = []; return { out, err, io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) } }; };
  const command = (options: Parameters<typeof createAutoUpdateCommand>[0] = {}) => createAutoUpdateCommand({ env: { TENANCY: 'single' }, clock, scope: db.forGym,
    resolveGymId: async () => gymId, settings, backups: async () => true, restoring: async () => false, hasGym: async () => true, ...options });
  return { gymId, clock, settings, attempts, tile, turn, io, command };
}
const at = (iso: string) => new Date(iso).toISOString();
const attempt = (fields: Partial<AutoUpdateAttempt>): AutoUpdateAttempt =>
  ({ attemptedAt: at('2026-11-03T16:05:00Z'), result: 'up_to_date', reason: null, fromVersion: 'v1.2.3', toVersion: null, ...fields });

describe('automatic update attempts', () => {
  it('accepts each result only with the facts it can know', () => {
    const valid: Partial<AutoUpdateAttempt>[] = [{}, { result: 'updated', toVersion: 'v1.2.4' },
      { result: 'skipped', reason: 'backups_not_configured' }, { result: 'skipped', reason: 'version_unknown', fromVersion: null },
      { result: 'skipped', reason: 'signature_invalid', toVersion: 'v1.2.4' }, { result: 'rolled_back', reason: 'health_check_failed', toVersion: 'v1.2.4' },
      { result: 'failed', reason: 'rollback_failed', toVersion: 'v1.2.4' }, { fromVersion: '0.0.0-dev' }];
    for (const fields of valid) expect(autoUpdateAttemptSchema.safeParse(attempt(fields)).success, JSON.stringify(fields)).toBe(true);
    const invalid: Partial<AutoUpdateAttempt>[] = [{ reason: 'disabled' }, { toVersion: 'v1.2.4' }, { fromVersion: null },
      { result: 'updated' }, { result: 'skipped' }, { result: 'skipped', reason: 'health_check_failed' },
      { result: 'rolled_back', reason: 'snapshot_failed', toVersion: 'v1.2.4' }, { result: 'failed', reason: null, toVersion: 'v1.2.4' },
      { fromVersion: 'latest' }, { fromVersion: 'v1.2.3; rm -rf /' }, { attemptedAt: 'yesterday' }];
    for (const fields of invalid) expect(autoUpdateAttemptSchema.safeParse(attempt(fields)).success, JSON.stringify(fields)).toBe(false);
    expect(autoUpdateAttemptSchema.safeParse({ ...attempt({}), extra: true }).success).toBe(false);
  });
  it('words every reason the updater can report', () => {
    for (const reason of Object.values(autoUpdateReasons).flat()) expect(messages, reason).toHaveProperty(['reason.' + reason]);
  });
  it('records attempts and reads the latest one', async () => {
    const f = await fixture();
    expect(await f.attempts.latest(f.gymId)).toBeNull();
    await f.attempts.record(f.gymId, attempt({ result: 'skipped', reason: 'snapshot_failed', toVersion: 'v1.2.4' }));
    f.clock.advance(86_400_000);
    await f.attempts.record(f.gymId, attempt({ attemptedAt: at('2026-11-04T16:05:00Z'), result: 'updated', toVersion: 'v1.2.4' }));
    expect(await f.attempts.latest(f.gymId)).toMatchObject({ result: 'updated', toVersion: 'v1.2.4' });
    await expect(f.attempts.record(f.gymId, attempt({ result: 'updated' }))).rejects.toThrow();
  });
});

describe('automatic updates tile', () => {
  it('reads not set up before the first nightly check, and off when the owner turned it off', async () => {
    const f = await fixture();
    expect(await f.tile()).toMatchObject({ status: 'not_configured', message: expect.stringContaining('No nightly update check has run yet'),
      details: { enabled: true, lastAttemptAt: null, result: 'never_run', fromVersion: null, toVersion: null } });
    await f.turn(false);
    expect(await f.tile()).toMatchObject({ status: 'not_configured', message: expect.stringContaining('off'), details: { enabled: false } });
    await f.attempts.record(f.gymId, attempt({ result: 'skipped', reason: 'disabled' }));
    expect(await f.tile()).toMatchObject({ status: 'not_configured', details: { enabled: false, result: 'skipped' } });
    // Turned back on: the next night's check simply hasn't run yet.
    await f.turn(true);
    expect(await f.tile()).toMatchObject({ status: 'not_configured', message: expect.stringContaining('next check runs tonight') });
  });
  it.each([
    [{}, 'healthy', 'Version v1.2.3 is the newest patch release.'],
    [{ result: 'updated', toVersion: 'v1.2.4' }, 'healthy', 'Updated from v1.2.3 to v1.2.4.'],
    [{ result: 'rolled_back', reason: 'health_check_failed', toVersion: 'v1.2.4' }, 'warning', 'Version v1.2.4 was rolled back and v1.2.3 is running again. The new version failed its health check.'],
    [{ result: 'failed', reason: 'rollback_failed', toVersion: 'v1.2.4' }, 'error', 'The update to v1.2.4 failed.'],
    [{ result: 'skipped', reason: 'backups_not_configured' }, 'warning', 'No update was installed. Backups aren\'t set up'],
    [{ result: 'skipped', reason: 'snapshot_failed', toVersion: 'v1.2.4' }, 'warning', 'Version v1.2.4 was not installed. The backup before the update failed.'],
    [{ result: 'skipped', reason: 'signature_invalid', toVersion: 'v1.2.4' }, 'error', 'signature didn\'t verify'],
    [{ result: 'skipped', reason: 'digest_mismatch', toVersion: 'v1.2.4' }, 'error', 'doesn\'t match the signed release manifest'],
    [{ result: 'skipped', reason: 'migration_in_patch', toVersion: 'v1.2.4' }, 'error', 'changes the database'],
  ] as const)('shows %o as %s', async (fields, status, text) => {
    const f = await fixture(), recorded = attempt(fields as Partial<AutoUpdateAttempt>);
    await f.attempts.record(f.gymId, recorded);
    const tile = await f.tile();
    expect(tile).toMatchObject({ status, details: { enabled: true, lastAttemptAt: '2026-11-03T16:05:00.000Z', result: recorded.result } });
    expect(tile.message).toContain(text);
  });
  it('warns when no nightly check has been reported for two days', async () => {
    const f = await fixture();
    await f.attempts.record(f.gymId, attempt({}));
    f.clock.advance(49 * 3_600_000);
    expect(await f.tile()).toMatchObject({ status: 'healthy' });
    f.clock.advance(2 * 3_600_000);
    expect(await f.tile()).toMatchObject({ status: 'warning', message: expect.stringContaining('systemctl status plaingym-update.timer') });
  });
  it('shows nothing of another gym\'s attempts', async () => {
    const a = await fixture(), b = await fixture();
    await a.attempts.record(a.gymId, attempt({ result: 'failed', reason: 'rollback_failed', toVersion: 'v1.2.4' }));
    expect(await b.tile()).toMatchObject({ status: 'not_configured', details: { result: 'never_run' } });
    expect(await b.attempts.latest(b.gymId)).toBeNull();
    // A scope that resolves gym B can't read gym A's attempts under row-level security.
    const asGymB = ((_gymId: string, fn: Parameters<typeof db.forGym>[1]) => db.forGym(b.gymId, fn)) as typeof db.forGym;
    expect(await createAutoUpdateAttempts({ scope: asGymB, clock: a.clock }).latest(a.gymId)).toBeNull();
  });
  it('reads not set up on an install that serves several gyms, and is hidden from staff below managers', async () => {
    const f = await fixture();
    const multi = createAutoUpdateHealthProvider({ scope: db.forGym, tenancy: 'multi' });
    expect(await multi.read({ gymId: f.gymId, roles: ['owner'], clock: f.clock })).toMatchObject({ status: 'not_configured', details: null });
    const service = createHealthService([createAutoUpdateHealthProvider({ scope: db.forGym, tenancy: 'single' })]);
    const tiles = (await service.get({ gymId: f.gymId, roles: ['admin'], clock: f.clock })).data.tiles;
    expect(tiles.find((tile) => tile.id === 'automatic_updates')).toMatchObject({ status: 'not_configured', details: { result: 'never_run' } });
    await expect(service.get({ gymId: f.gymId, roles: ['coach'], clock: f.clock })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('gym-app auto-update', () => {
  it('prints the switch, the backup state and the gym timezone for the host updater', async () => {
    const f = await fixture(), out = f.io();
    expect(await f.command().run(['check'], out.io)).toBe(0);
    expect(out.out.join('\n').split('\n')).toEqual(['restore=false', 'setup=true', 'enabled=true', 'backups=true', 'timezone=Australia/Sydney']);
    await f.turn(false);
    const off = f.io();
    expect(await f.command({ backups: async () => false }).run(['check'], off.io)).toBe(0);
    expect(off.out.join('\n').split('\n')).toEqual(['restore=false', 'setup=true', 'enabled=false', 'backups=false', 'timezone=Australia/Sydney']);
  });
  it('says setup=false, and nothing else, before the setup wizard has created the gym', async () => {
    const f = await fixture(), out = f.io();
    const command = f.command({ hasGym: async () => false, resolveGymId: async () => { throw new Error('Expected exactly one gym in this install'); } });
    expect(await command.run(['check'], out.io)).toBe(0);
    expect(out.out.join('\n').split('\n')).toEqual(['restore=false', 'setup=false']);
    expect(out.err).toEqual([]);
  });
  it('answers only restore=true while a restore holds the install, and records nothing then', async () => {
    const f = await fixture(), out = f.io();
    let read = false;
    const settings = { ...f.settings, get: async (gymId: string) => { read = true; return f.settings.get(gymId); } };
    expect(await f.command({ restoring: async () => true, settings }).run(['check'], out.io)).toBe(0);
    expect(out.out).toEqual(['restore=true']);
    expect(read).toBe(false);
    const record = f.io();
    expect(await f.command({ restoring: async () => true }).run(['record', '--at', '2026-11-03T16:05:00Z', '--result', 'up_to_date', '--from', 'v1.2.3'], record.io)).toBe(1);
    expect(await f.attempts.latest(f.gymId)).toBeNull();
  });
  it('records an attempt for the tile', async () => {
    const f = await fixture(), out = f.io();
    expect(await f.command().run(['record', '--at', '2026-11-03T16:05:00Z', '--result', 'rolled_back', '--reason', 'startup_failed',
      '--from', 'v1.2.3', '--to', 'v1.2.4'], out.io)).toBe(0);
    expect(out.out).toEqual(['Recorded.']);
    expect(await f.attempts.latest(f.gymId)).toEqual({ attemptedAt: '2026-11-03T16:05:00Z', result: 'rolled_back', reason: 'startup_failed',
      fromVersion: 'v1.2.3', toVersion: 'v1.2.4' });
    expect(await f.tile()).toMatchObject({ status: 'warning', details: { result: 'rolled_back' } });
  });
  it('refuses malformed input, an install serving several gyms, and reports failures without a stack', async () => {
    const f = await fixture();
    for (const args of [[], ['check', 'extra'], ['record'], ['record', '--at'], ['record', '--at', '2026-11-03T16:05:00Z', '--result', 'up_to_date', '--from', 'v1.2.3', '--from', 'v1.2.4'],
      ['record', '--at', '2026-11-03T16:05:00Z', '--result', 'updated', '--from', 'v1.2.3'], ['record', '--at', '2026-11-03T16:05:00Z', '--result', 'up_to_date', '--from', 'v1.2.3', '--gym', 'x'],
      ['update']]) {
      const out = f.io();
      expect(await f.command().run(args, out.io), JSON.stringify(args)).toBe(2);
    }
    expect(await f.attempts.latest(f.gymId)).toBeNull();
    const multi = f.io();
    expect(await f.command({ env: { TENANCY: 'multi' } }).run(['check'], multi.io)).toBe(1);
    expect(multi.err).toEqual(['Automatic updates run only on a single-gym install']);
    const broken = f.io();
    expect(await f.command({ resolveGymId: async () => { throw new Error('Expected exactly one gym in this install'); } }).run(['check'], broken.io)).toBe(1);
    expect(broken.err).toEqual(['Expected exactly one gym in this install']);
  });
});
