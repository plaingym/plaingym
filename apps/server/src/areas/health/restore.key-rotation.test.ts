// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { authAccount, encryptedFields, gyms, uuidv7 } from '@plaingym/db';
import { cloneDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { decryptSecret, encryptSecret, openSecret, type SecretClass, type SecretContext } from '../../core/secrets.js';
import { legacySecret } from '../../core/secrets.test-helper.js';
import { PostgresMaintenance, UnreadableSecretsError } from './backups.database.js';

const oldKey = randomBytes(32), newKey = randomBytes(32);
const columns = {
  stripe_config: 'stripeConfig', smtp_config: 'smtpConfig', s3_config: 's3Config', qr_key: 'qrKey', backup_blob_key: 'backupBlobKey',
  google_config: 'googleConfig', oauth_access_token: 'accessToken', oauth_refresh_token: 'refreshToken', oauth_id_token: 'idToken',
} as const satisfies Record<SecretClass, string>;
const plaintext = (context: SecretContext) => 'private ' + context.secretClass + ' of ' + context.owner;
const contextOf = (where: string): SecretContext => {
  const [secretClass, owner] = where.split(':') as [SecretClass, string];
  return { secretClass, owner };
};
/**
 * An install of two gyms, each with a sign-in account, holding every secret class under `key`: some as v1 envelopes,
 * the rest as v2 ones, and one column left empty. Its own database, so a rotation sees only these rows.
 */
async function install(key: Buffer) {
  const database = await cloneDatabase(inject('testDatabase')), make = createFactories(database);
  // In ID order, the order a rotation takes them in (UUIDv7s made in the same millisecond needn't be).
  const gymIds = [uuidv7(), uuidv7()].sort(), accountIds = [uuidv7(), uuidv7()].sort();
  const value = (secretClass: SecretClass, owner: string, legacy: boolean) =>
    legacy ? legacySecret(key, secretClass, plaintext({ secretClass, owner })) : encryptSecret(key, { secretClass, owner }, plaintext({ secretClass, owner }));
  for (const [index, gymId] of gymIds.entries()) {
    await make('gyms', gymId, { stripeConfig: value('stripe_config', gymId, index === 1), smtpConfig: value('smtp_config', gymId, true),
      s3Config: value('s3_config', gymId, false), qrKey: value('qr_key', gymId, index === 0), backupBlobKey: value('backup_blob_key', gymId, false),
      googleConfig: index === 0 ? value('google_config', gymId, false) : null });
    const accountId = accountIds[index]!;
    await make('authAccount', gymId, { id: accountId, accessToken: value('oauth_access_token', accountId, index === 0),
      refreshToken: value('oauth_refresh_token', accountId, true), idToken: value('oauth_id_token', accountId, false) });
  }
  /** Every stored value by `class:row`. */
  async function stored(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const rows = await database.forSystem(async (tx) => [...await tx.select().from(gyms), ...await tx.select().from(authAccount)]);
    for (const row of rows) for (const field of encryptedFields) {
      const value = (row as Record<string, unknown>)[columns[field.secretClass]];
      if (typeof value === 'string') result.set(field.secretClass + ':' + row.id, value);
    }
    return result;
  }
  return { database, gymIds, accountIds, stored, maintenance: new PostgresMaintenance(database.maintenanceUrl), cleanup: database.cleanup };
}
type Install = Awaited<ReturnType<typeof install>>;
async function withInstall(key: Buffer, test: (install: Install) => Promise<void>) {
  const subject = await install(key);
  try { await test(subject); } finally { await subject.cleanup(); }
}
/** Each value opens as v2 with `key` in its own row, with its own plaintext, and not with `other`. */
function expectRotated(values: ReadonlyMap<string, string>, key: Buffer, other: Buffer) {
  for (const [where, value] of values) {
    const context = contextOf(where);
    expect(openSecret(key, context, value)).toEqual({ version: 'v2', plaintext: plaintext(context) });
    expect(() => decryptSecret(other, context, value)).toThrow('Unable to decrypt secret');
  }
}

describe('APP_ENCRYPTION_KEY rotation', { timeout: 60_000 }, () => {
  it('re-encrypts every stored secret, v1 or v2, as v2 under the new key, each bound to its own row', async () => {
    await withInstall(oldKey, async ({ stored, maintenance, gymIds }) => {
      const before = await stored();
      expect(before.size).toBe(17);
      expect((await maintenance.rotateKey(oldKey, newKey)).rewritten).toBe(17);
      const after = await stored();
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      expectRotated(after, newKey, oldKey);
      // Gym A's rotated value opens nowhere but in gym A's row and column.
      const stripeA = after.get('stripe_config:' + gymIds[0])!;
      expect(() => decryptSecret(newKey, { secretClass: 'stripe_config', owner: gymIds[1]! }, stripeA)).toThrow();
      expect(() => decryptSecret(newKey, { secretClass: 'smtp_config', owner: gymIds[0]! }, stripeA)).toThrow();
      // Done is done: running it again changes nothing.
      expect((await maintenance.rotateKey(oldKey, newKey)).rewritten).toBe(0);
      expect(await stored()).toEqual(after);
    });
  });

  it('resumes after a crash: what was committed stays, the rest follows, and the gyms come last', async () => {
    await withInstall(oldKey, async ({ stored, maintenance, gymIds, accountIds }) => {
      const before = await stored(), commits: string[] = [];
      // Power is lost after the second commit: the sign-in accounts (one page) and then the first gym.
      await expect(maintenance.rotateKey(oldKey, newKey, (table) => {
        commits.push(table);
        if (commits.length === 2) throw new Error('Power loss');
      })).rejects.toThrow('Power loss');
      expect(commits).toEqual(['auth_account', 'gyms']);
      const interrupted = await stored();
      for (const [where, value] of interrupted) {
        const context = contextOf(where), done = context.owner !== gymIds[1];
        expect(decryptSecret(done ? newKey : oldKey, context, value)).toBe(plaintext(context));
        if (!done) expect(value).toBe(before.get(where));
      }
      expect(accountIds.every((id) => interrupted.get('oauth_id_token:' + id) !== before.get('oauth_id_token:' + id))).toBe(true);
      // Run again with the same keys: only gym B's five values are left.
      expect((await maintenance.rotateKey(oldKey, newKey)).rewritten).toBe(5);
      const after = await stored();
      expectRotated(after, newKey, oldKey);
      for (const [where, value] of interrupted) if (contextOf(where).owner !== gymIds[1]) expect(after.get(where)).toBe(value);
    });
  });

  it('changes nothing with a wrong old key, and names each value it could not open, never the value', async () => {
    await withInstall(oldKey, async ({ stored, maintenance }) => {
      const before = await stored(), wrong = randomBytes(32);
      const error = await maintenance.rotateKey(wrong, newKey).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnreadableSecretsError);
      const { unreadable, message } = error as UnreadableSecretsError;
      expect(unreadable.map((value) => value.secretClass + ':' + value.owner).sort()).toEqual([...before.keys()].sort());
      expect(message).toBe('Stored secrets open with neither key');
      for (const key of [oldKey, newKey, wrong]) expect(JSON.stringify({ message, unreadable })).not.toContain(key.toString('hex'));
      expect(await stored()).toEqual(before);
    });
  });

  it('refuses a value copied into another gym\'s row before changing any gym, and names that row', async () => {
    await withInstall(oldKey, async ({ database, stored, maintenance, gymIds }) => {
      const [gymA, gymB] = gymIds as [string, string];
      const stripeA = (await stored()).get('stripe_config:' + gymA)!;
      await database.forGym(gymB, (tx) => tx.update(gyms).set({ stripeConfig: stripeA }).where(eq(gyms.id, gymB)));
      const before = await stored();
      const error = await maintenance.rotateKey(oldKey, newKey).catch((caught: unknown) => caught);
      expect((error as UnreadableSecretsError).unreadable).toEqual([{ secretClass: 'stripe_config', owner: gymB }]);
      expect(await stored()).toEqual(before);
      // Once gym B's row holds its own value again, the rotation goes through.
      await database.forGym(gymB, (tx) => tx.update(gyms).set({ stripeConfig: encryptSecret(oldKey, { secretClass: 'stripe_config', owner: gymB },
        plaintext({ secretClass: 'stripe_config', owner: gymB })) }).where(eq(gyms.id, gymB)));
      await maintenance.rotateKey(oldKey, newKey);
      expectRotated(await stored(), newKey, oldKey);
    });
  });

  it('stops without claiming nothing changed when a value changes after its check, and finishes when run again', async () => {
    await withInstall(oldKey, async ({ database, stored, maintenance, gymIds }) => {
      const gymB = gymIds[1]!, stripe = { secretClass: 'stripe_config', owner: gymB } as const;
      const set = (value: string) => database.forGym(gymB, (tx) => tx.update(gyms).set({ stripeConfig: value }).where(eq(gyms.id, gymB)));
      // Something still running writes gym B's Stripe settings under another key after the check passed.
      const error = await maintenance.rotateKey(oldKey, newKey, async (table) => {
        if (table === 'auth_account') await set(encryptSecret(randomBytes(32), stripe, 'written meanwhile'));
      }).catch((caught: unknown) => caught);
      expect(error).not.toBeInstanceOf(UnreadableSecretsError);
      expect((error as Error).message).toBe('A stored secret changed during the key rotation');
      // What committed before stays rotated; gym B's row is untouched.
      const interrupted = await stored();
      expect(openSecret(newKey, { secretClass: 'qr_key', owner: gymIds[0]! }, interrupted.get('qr_key:' + gymIds[0])!).version).toBe('v2');
      expect(decryptSecret(oldKey, { secretClass: 'qr_key', owner: gymB }, interrupted.get('qr_key:' + gymB)!)).toBe(plaintext({ secretClass: 'qr_key', owner: gymB }));
      await set(encryptSecret(oldKey, stripe, plaintext(stripe)));
      await maintenance.rotateKey(oldKey, newKey);
      expectRotated(await stored(), newKey, oldKey);
    });
  });

  it('waits for a running backup, which holds the backup lock, and refuses one key twice', async () => {
    await withInstall(oldKey, async ({ maintenance }) => {
      await expect(maintenance.rotateKey(oldKey, Buffer.from(oldKey))).rejects.toThrow('two different keys');
      let rotated = false, rotation: Promise<unknown> | undefined;
      await maintenance.locked(async () => {
        rotation = maintenance.rotateKey(oldKey, newKey).then(() => { rotated = true; });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(rotated).toBe(false);
      });
      await rotation;
      expect(rotated).toBe(true);
    });
  });
});

describe('the one-time v1 to v2 rewrite after migrations', { timeout: 60_000 }, () => {
  it('rewrites v1 values as v2 under the same key, and leaves v2 values and ones the key cannot open', async () => {
    await withInstall(oldKey, async ({ database, stored, maintenance, gymIds }) => {
      const gymB = gymIds[1]!, unreadable = legacySecret(randomBytes(32), 'qr_key', 'under another key');
      await database.forGym(gymB, (tx) => tx.update(gyms).set({ qrKey: unreadable }).where(eq(gyms.id, gymB)));
      const before = await stored(), legacy = [...before].filter(([, value]) => value.startsWith('v1.'));
      expect(legacy).toHaveLength(8);
      expect(await maintenance.upgradeSecrets(oldKey)).toEqual({ rewritten: 7, unreadable: 1 });
      const after = await stored();
      for (const [where, value] of after) {
        if (where === 'qr_key:' + gymB) { expect(value).toBe(unreadable); continue; }
        const context = contextOf(where);
        expect(openSecret(oldKey, context, value)).toEqual({ version: 'v2', plaintext: plaintext(context) });
        if (!before.get(where)!.startsWith('v1.')) expect(value).toBe(before.get(where));
      }
      // Each rewritten value is now bound to its gym: gym B's former v1 Stripe settings don't open in gym A's row.
      expect(() => decryptSecret(oldKey, { secretClass: 'stripe_config', owner: gymIds[0]! }, after.get('stripe_config:' + gymB)!)).toThrow();
      // Nothing more to do on the next start; the unreadable value is counted again and left alone.
      expect(await maintenance.upgradeSecrets(oldKey)).toEqual({ rewritten: 0, unreadable: 1 });
      expect(await stored()).toEqual(after);
    });
  });
});
