// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
// Test-only maintenance connection reads the stored envelopes while the app's pools are closed.
// eslint-disable-next-line no-restricted-imports
import { openConnection, scopedDatabase } from '@plaingym/db/client';
import { setLogSink } from '../core/log.js';
import { encryptSecret, openSecret } from '../core/secrets.js';
import { legacySecret } from '../core/secrets.test-helper.js';
import { PostgresMaintenance } from '../areas/health/backups.database.js';
import { RestoreGate } from '../areas/health/restore.gate.js';
import { maintenanceCommand } from './restore.js';
import { reportMaintenanceFailure } from './restore.failure.js';
import { KeyRotationPartialError, KeyRotationRefusedError, KeyRotationUnstartedError, rotateKey } from './restore.rotate-key.js';

const db = useTestDatabase(), make = createFactories(db);
const current = randomBytes(32), next = randomBytes(32), third = randomBytes(32), gymId = uuidv7();
const hex = (key: Buffer) => key.toString('hex');
const stripe = { secretClass: 'stripe_config', owner: gymId } as const, smtp = { secretClass: 'smtp_config', owner: gymId } as const;
let directory: string, output: string[];
const io = () => ({ stdout: (line: string) => output.push(line), stderr: (line: string) => output.push(line) });
async function storedValues(): Promise<{ stripe: string; smtp: string }> {
  const connection = openConnection(db.maintenanceUrl, 1);
  try {
    const [row] = await connection.sql<{ stripe: string; smtp: string }[]>`select stripe_config_encrypted as stripe,
      smtp_config_encrypted as smtp from gyms where id = ${gymId}::uuid`;
    return row!;
  } finally { await connection.close(); }
}
async function refusal(options: Partial<Parameters<typeof rotateKey>[0]>): Promise<KeyRotationRefusedError> {
  const error = await rotateKey({ database: new PostgresMaintenance(db.maintenanceUrl), currentKey: hex(current), newKey: hex(next),
    gate: null, ...io(), ...options }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(KeyRotationRefusedError);
  expect((error as KeyRotationRefusedError).exitCode).toBe(error instanceof KeyRotationPartialError ? 2 : error instanceof KeyRotationUnstartedError ? 4 : 3);
  return error as KeyRotationRefusedError;
}
/** A maintenance handle whose rotations give up waiting for app sessions after half a second, not 30. */
function quickDrain(): PostgresMaintenance {
  const database = new PostgresMaintenance(db.maintenanceUrl), original = database.rotateKey.bind(database);
  vi.spyOn(database, 'rotateKey').mockImplementation((from, to, afterCommit) => original(from, to, afterCommit, 500));
  return database;
}
async function appCanConnect(): Promise<boolean> {
  const connection = openConnection(db.maintenanceUrl, 1);
  try {
    const [row] = await connection.sql<{ granted: boolean }[]>`select has_database_privilege('app', current_database(), 'CONNECT') as granted`;
    return row!.granted;
  } finally { await connection.close(); }
}
async function withMaintenanceEnvironment(action: () => Promise<void>): Promise<void> {
  const saved = process.env.MAINTENANCE_DATABASE_URL;
  process.env.MAINTENANCE_DATABASE_URL = db.maintenanceUrl;
  try { await action(); } finally {
    if (saved === undefined) delete process.env.MAINTENANCE_DATABASE_URL; else process.env.MAINTENANCE_DATABASE_URL = saved;
  }
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plaingym-rotate-key-'));
  await make('gyms', gymId, { stripeConfig: encryptSecret(current, stripe, 'stripe-private'), smtpConfig: legacySecret(current, 'smtp_config', 'smtp-private') });
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe('maintenance.mjs rotate-key', { timeout: 60_000 }, () => {
  it('refuses missing, malformed or equal keys, naming the variable and never the value', async () => {
    output = [];
    const before = await storedValues();
    for (const [options, message] of [
      [{ currentKey: undefined }, 'APP_ENCRYPTION_KEY must be 64 hex characters'],
      [{ currentKey: 'private-current-input' }, 'APP_ENCRYPTION_KEY must be 64 hex characters'],
      [{ newKey: undefined }, 'NEW_APP_ENCRYPTION_KEY must be 64 hex characters'],
      [{ newKey: 'private-new-input' + 'a'.repeat(47) }, 'NEW_APP_ENCRYPTION_KEY must be 64 hex characters'],
      [{ newKey: hex(current).toUpperCase() }, 'NEW_APP_ENCRYPTION_KEY is the current key; generate a new one'],
    ] as const) expect((await refusal(options)).message).toBe(message);
    expect(output).toEqual([]);
    expect(JSON.stringify(await storedValues()) === JSON.stringify(before)).toBe(true);
  });

  it('refuses during a restore, and while the app is connected to the database', async () => {
    output = [];
    const before = await storedValues(), gate = new RestoreGate(directory);
    await writeFile(gate.statePath, JSON.stringify({ phase: 'verified' }));
    expect((await refusal({ gate })).message).toBe('A restore is in progress; let it finish, then rotate the key');
    await rm(gate.statePath);
    // The factories above used the app's pool, whose connections are still open.
    expect(await new PostgresMaintenance(db.maintenanceUrl).appSessions()).toBeGreaterThan(0);
    const error = await refusal({ gate, database: quickDrain() });
    expect(error.message).toMatch(/^Key rotation refused: \d+ app sessions remain;/);
    expect(error.exitCode).toBe(3);
    expect(JSON.stringify(await storedValues()) === JSON.stringify(before)).toBe(true);
  });

  it('re-encrypts the stored secrets once the app is stopped, printing a count and no key or value', async () => {
    output = [];
    await db.app.close(); await db.system.close();
    expect(await new PostgresMaintenance(db.maintenanceUrl).appSessions()).toBe(0);
    await rotateKey({ database: new PostgresMaintenance(db.maintenanceUrl), currentKey: hex(current), newKey: hex(next), gate: new RestoreGate(directory), ...io() });
    // The fence stays until the host lifts it with the restore-connect command, against this real database.
    expect(await appCanConnect()).toBe(false);
    await withMaintenanceEnvironment(() => maintenanceCommand(['restore-connect']));
    expect(await appCanConnect()).toBe(true);
    await expect(maintenanceCommand(['restore-connect', 'extra'])).rejects.toThrow('Usage: restore-connect');
    expect(output).toEqual(['Stored secrets re-encrypted with the new key (2 values changed)']);
    const after = await storedValues();
    const openedStripe = openSecret(next, stripe, after.stripe);
    expect(openedStripe.version === 'v2' && openedStripe.plaintext === 'stripe-private').toBe(true);
    const openedSmtp = openSecret(next, smtp, after.smtp);
    expect(openedSmtp.version === 'v2' && openedSmtp.plaintext === 'smtp-private').toBe(true);
  });

  it('names the values neither key opens, and the maintenance CLI prints its refusal as written', async () => {
    output = [];
    const connection = openConnection(db.maintenanceUrl, 1);
    try { await connection.sql`update gyms set smtp_config_encrypted = ${encryptSecret(third, smtp, 'lost')} where id = ${gymId}::uuid`; }
    finally { await connection.close(); }
    const before = await storedValues();
    // The install now runs with `next`; one value is under a key it doesn't have.
    const error = await refusal({ currentKey: hex(next), newKey: hex(current) });
    // No value opens with the new key, so no run of this rotation committed anything: the host may restart the app.
    expect(error).toBeInstanceOf(KeyRotationUnstartedError);
    expect(error.message).toBe('1 stored secrets open with neither key, so this run changed nothing. No stored secret uses the new key yet, '
      + 'so the app can restart with the current key. Check that APP_ENCRYPTION_KEY is the key the install runs with; a setting listed '
      + 'above that is already unreadable can be removed and entered again');
    expect(output).toEqual(['Opens with neither key: smtp_config of gym ' + gymId]);
    expect(JSON.stringify(await storedValues()) === JSON.stringify(before)).toBe(true);
    const lines: string[] = [], logs: string[] = [], previous = setLogSink((line) => logs.push(line));
    try { reportMaintenanceFailure(['rotate-key'], error, (line) => lines.push(line)); } finally { setLogSink(previous); }
    expect(lines).toEqual([error.message]);
    for (const text of [...output, ...lines, ...logs]) for (const key of [current, next, third]) expect(text.includes(hex(key))).toBe(false);
  });

  it('keeps a resumed rotation stopped when a value already uses the new key and another opens with neither', async () => {
    output = [];
    const connection = openConnection(db.maintenanceUrl, 1);
    // As after an earlier run that committed the Stripe page: Stripe is under the new key, SMTP under neither.
    try { await connection.sql`update gyms set stripe_config_encrypted = ${encryptSecret(current, stripe, 'stripe-private')} where id = ${gymId}::uuid`; }
    finally { await connection.close(); }
    const before = await storedValues();
    const error = await refusal({ currentKey: hex(next), newKey: hex(current) });
    expect(error).toBeInstanceOf(KeyRotationPartialError);
    expect(error.message).toBe('1 stored secrets open with neither key, so this run changed nothing. An earlier run already re-encrypted 1 '
      + 'values with the new key, so the app must stay stopped until the rotation finishes. Check that APP_ENCRYPTION_KEY is the key the '
      + 'install runs with');
    expect(output).toEqual(['Opens with neither key: smtp_config of gym ' + gymId]);
    expect(JSON.stringify(await storedValues()) === JSON.stringify(before)).toBe(true);
    await withMaintenanceEnvironment(() => maintenanceCommand(['restore-connect']));
    // Back to the install's key, as the tests below expect.
    const reset = openConnection(db.maintenanceUrl, 1);
    try { await reset.sql`update gyms set stripe_config_encrypted = ${encryptSecret(next, stripe, 'stripe-private')} where id = ${gymId}::uuid`; }
    finally { await reset.close(); }
  });

  it('rewrites both gyms\' v1 values in a multi-gym migrate run with the app key it is given', async () => {
    const otherGym = uuidv7();
    const connection = openConnection(db.maintenanceUrl, 1);
    try {
      await connection.sql`update gyms set smtp_config_encrypted = ${legacySecret(next, 'smtp_config', 'smtp-again')} where id = ${gymId}::uuid`;
      await createFactories(scopedDatabase(connection.db))('gyms', otherGym,
        { smtpConfig: legacySecret(next, 'smtp_config', 'other-smtp') });
    }
    finally { await connection.close(); }
    const saved = { url: process.env.MAINTENANCE_DATABASE_URL, key: process.env.APP_ENCRYPTION_KEY, tenancy: process.env.TENANCY };
    const logs: string[] = [], previous = setLogSink((line) => logs.push(line));
    try {
      process.env.MAINTENANCE_DATABASE_URL = db.maintenanceUrl; process.env.APP_ENCRYPTION_KEY = hex(next);
      process.env.TENANCY = 'multi';
      await maintenanceCommand(['migrate']);
    } finally {
      setLogSink(previous);
      for (const [name, value] of [['MAINTENANCE_DATABASE_URL', saved.url], ['APP_ENCRYPTION_KEY', saved.key], ['TENANCY', saved.tenancy]] as const)
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    const opened = openSecret(next, smtp, (await storedValues()).smtp);
    expect(opened.version === 'v2' && opened.plaintext === 'smtp-again').toBe(true);
    const check = openConnection(db.maintenanceUrl, 1);
    try {
      const [row] = await check.sql<{ value: string }[]>`select smtp_config_encrypted as value from gyms where id = ${otherGym}::uuid`;
      const opened = openSecret(next, { secretClass: 'smtp_config', owner: otherGym }, row!.value);
      expect(opened.version === 'v2' && opened.plaintext === 'other-smtp').toBe(true);
    } finally { await check.close(); }
    expect(logs.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([expect.objectContaining({ event: 'secrets.upgraded', rewritten: 2, unreadable: 0 })]);
  });

  it('logs the skipped secret upgrade when migrate has no key', async () => {
    const saved = { url: process.env.MAINTENANCE_DATABASE_URL, key: process.env.APP_ENCRYPTION_KEY };
    const logs: string[] = [], previous = setLogSink((line) => logs.push(line));
    try {
      process.env.MAINTENANCE_DATABASE_URL = db.maintenanceUrl;
      delete process.env.APP_ENCRYPTION_KEY;
      await maintenanceCommand(['migrate']);
    } finally {
      setLogSink(previous);
      for (const [name, value] of [['MAINTENANCE_DATABASE_URL', saved.url], ['APP_ENCRYPTION_KEY', saved.key]] as const)
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    expect(logs.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(expect.objectContaining({ event: 'secrets.upgrade_skipped' }));
  });

  it.each([false, true])('reports partial rotation after a committed page or failed output (interrupted=%s)', async (interrupted) => {
    const database = new PostgresMaintenance(db.maintenanceUrl), original = database.rotateKey.bind(database);
    // Inject a failure after a real PostgreSQL commit; the database is not mocked.
    const rotation = vi.spyOn(database, 'rotateKey').mockImplementation((from, to) => original(from, to, () => {
      if (interrupted) throw new Error('Interrupted after commit');
    }));
    try {
      const error = await refusal({ database, stdout: () => { throw new Error('Output unavailable'); } });
      expect(error).toBeInstanceOf(KeyRotationPartialError);
      expect((error as KeyRotationPartialError).exitCode).toBe(2);
    } finally { rotation.mockRestore(); await database.restoreAppConnect(); }
  });
});
